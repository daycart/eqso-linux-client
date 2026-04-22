import { EventEmitter } from "events";

export interface RemoteMember {
  name: string;
  message: string;
  isTx: boolean;
}

export interface RemoteConnectionInfo {
  id: string;
  host: string;
  port: number;
  name: string;
  room: string;
  status: "connecting" | "connected" | "disconnected";
  connectedAt: number;
  txBytes: number;
  rxBytes: number;
  remoteMembers: RemoteMember[];
  wsSend?: (data: object) => void;
  wsSendBin?: (data: Buffer) => void;
}

export interface ClientInfo {
  id: string;
  name: string;
  room: string;
  message: string;
  protocol: "tcp" | "ws";
  connectedAt: number;
  txBytes: number;
  rxBytes: number;
  pingMs: number;
  send: (data: Buffer) => void;
  close: () => void;
}

export interface RoomEvent {
  type: "join" | "leave" | "ptt_start" | "ptt_end" | "audio" | "message";
  clientId: string;
  name: string;
  room: string;
  data?: Buffer;
}

type RoomListenerCallback = (room: string, data: Buffer, senderId: string) => void;

interface RoomListener {
  rooms: Set<string>;
  onData: RoomListenerCallback;
}

export class RoomManager extends EventEmitter {
  private clients = new Map<string, ClientInfo>();
  private rooms = new Map<string, Set<string>>();
  private roomLocks = new Map<string, string>();
  private _enabled = true;
  private _startedAt = Date.now();
  private remoteConns = new Map<string, RemoteConnectionInfo>();
  private roomListeners = new Map<string, RoomListener>();

  isEnabled(): boolean { return this._enabled; }
  enable(): void       { this._enabled = true; }
  disable(): void      { this._enabled = false; }
  get startedAt(): number { return this._startedAt; }

  getDefaultRooms(): string[] {
    return ["GENERAL", "CB", "ASORAPA", "PRUEBAS"];
  }

  getRooms(): string[] {
    const builtIn = this.getDefaultRooms();
    const active = Array.from(this.rooms.keys()).filter(
      (r) => !builtIn.includes(r)
    );
    return [...builtIn, ...active];
  }

  getRoomMembers(room: string): ClientInfo[] {
    const ids = this.rooms.get(room);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.clients.get(id))
      .filter((c): c is ClientInfo => !!c);
  }

  addClient(client: ClientInfo): void {
    this.clients.set(client.id, client);
  }

  removeClient(id: string): void {
    const client = this.clients.get(id);
    if (!client) return;
    if (client.room) this.leaveRoom(id);
    this.clients.delete(id);
  }

  joinRoom(clientId: string, room: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;

    const oldRoom = client.room;
    if (oldRoom && oldRoom !== room) this.leaveRoom(clientId);

    if (!this.rooms.has(room)) this.rooms.set(room, new Set());
    this.rooms.get(room)!.add(clientId);
    client.room = room;

    this.emit("event", { type: "join", clientId, name: client.name, room } as RoomEvent);
    return true;
  }

  leaveRoom(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client || !client.room) return;

    const room = client.room;
    const members = this.rooms.get(room);
    if (members) {
      members.delete(clientId);
      if (members.size === 0) this.rooms.delete(room);
    }

    if (this.roomLocks.get(room) === clientId) this.roomLocks.delete(room);

    this.emit("event", { type: "leave", clientId, name: client.name, room } as RoomEvent);
    client.room = "";
  }

  tryLockRoom(room: string, clientId: string): boolean {
    const existing = this.roomLocks.get(room);
    if (existing && existing !== clientId) return false;
    this.roomLocks.set(room, clientId);
    return true;
  }

  /** true si la sala ya está bloqueada por este cliente (ya había empezado a transmitir). */
  isLockedBy(room: string, clientId: string): boolean {
    return this.roomLocks.get(room) === clientId;
  }

  unlockRoom(room: string, clientId: string): void {
    if (this.roomLocks.get(room) === clientId) this.roomLocks.delete(room);
  }

  broadcastToRoom(room: string, data: Buffer, excludeId?: string): void {
    const members = this.rooms.get(room);
    if (members) {
      for (const id of members) {
        if (id === excludeId) continue;
        const c = this.clients.get(id);
        if (c) {
          try {
            c.send(data); // txBytes is tracked inside each client's send() callback
          } catch { /* ignore */ }
        }
      }
    }
    // Notify relay listeners subscribed to this room
    for (const listener of this.roomListeners.values()) {
      if (listener.rooms.has(room)) {
        try { listener.onData(room, data, excludeId ?? ""); } catch { /* ignore */ }
      }
    }
  }

  addRoomListener(id: string, rooms: string[], onData: RoomListenerCallback): void {
    this.roomListeners.set(id, { rooms: new Set(rooms), onData });
  }

  removeRoomListener(id: string): void {
    this.roomListeners.delete(id);
  }

  /** Broadcast data to TCP clients AND relay listeners (not WS browser clients).
   *  Use this for GSM packets that must reach hardware relays and TCP eQSO clients. */
  broadcastToTcpAndRelays(room: string, data: Buffer, excludeId?: string): void {
    const members = this.rooms.get(room);
    if (members) {
      for (const id of members) {
        if (id === excludeId) continue;
        const c = this.clients.get(id);
        if (c?.protocol === "tcp") {
          try { c.send(data); } catch { /* ignore */ }
        }
      }
    }
    for (const listener of this.roomListeners.values()) {
      if (listener.rooms.has(room)) {
        try { listener.onData(room, data, excludeId ?? ""); } catch { /* ignore */ }
      }
    }
  }

  /** Send data only to TCP clients in a room (skips WebSocket browser clients). */
  broadcastToTcpClientsInRoom(room: string, data: Buffer, excludeId?: string): void {
    const members = this.rooms.get(room);
    if (!members) return;
    for (const id of members) {
      if (id === excludeId) continue;
      const c = this.clients.get(id);
      if (c?.protocol === "tcp") {
        try { c.send(data); } catch { /* ignore */ }
      }
    }
  }

  /** Send a pre-decoded [0x11][Float32 PCM] packet directly to local WebSocket browser clients. */
  broadcastBinToLocalWsClients(room: string, data: Buffer, excludeId?: string): void {
    const members = this.rooms.get(room);
    if (!members) return;
    for (const id of members) {
      if (id === excludeId) continue;
      const c = this.clients.get(id);
      if (c?.protocol === "ws") {
        try { c.send(data); } catch { /* ignore */ }
      }
    }
  }

  broadcastToAll(data: Buffer, excludeId?: string): void {
    for (const [id, c] of this.clients) {
      if (id === excludeId) continue;
      try {
        c.send(data);
      } catch { /* ignore */ }
    }
  }

  getClient(id: string): ClientInfo | undefined {
    return this.clients.get(id);
  }

  isNameTaken(name: string, excludeId?: string): boolean {
    for (const [id, c] of this.clients) {
      if (id === excludeId) continue;
      if (c.name.toLowerCase() === name.toLowerCase()) return true;
    }
    return false;
  }

  // ── Remote connection tracking ──────────────────────────────────────────────
  addRemoteConn(info: RemoteConnectionInfo): void {
    this.remoteConns.set(info.id, info);
  }

  updateRemoteConn(id: string, partial: Partial<RemoteConnectionInfo>): void {
    const existing = this.remoteConns.get(id);
    if (existing) Object.assign(existing, partial);
  }

  removeRemoteConn(id: string): void {
    this.remoteConns.delete(id);
  }

  getRemoteConn(id: string): RemoteConnectionInfo | undefined {
    return this.remoteConns.get(id);
  }

  /** Broadcast a JSON message to all remote proxy WebSocket clients in the same room,
   *  except the one identified by excludeId (to avoid echo). */
  broadcastJsonToRemoteRoom(room: string, data: object, excludeId?: string): void {
    for (const conn of this.remoteConns.values()) {
      if (conn.id === excludeId) continue;
      if (conn.room !== room) continue;
      try {
        conn.wsSend?.(data);
      } catch { /* ignore */ }
    }
  }

  /** Broadcast a binary frame to all remote proxy WebSocket clients in the same room. */
  broadcastBinToRemoteRoom(room: string, data: Buffer): void {
    for (const conn of this.remoteConns.values()) {
      if (conn.room !== room) continue;
      try {
        conn.wsSendBin?.(data);
      } catch { /* ignore */ }
    }
  }

  /** Full status for the monitor panel */
  getServerStatus() {
    const now = Date.now();
    const allClients = Array.from(this.clients.values());

    const byRoom: Record<string, {
      room: string;
      locked: boolean;
      lockedBy: string;
      clients: {
        id: string; name: string; protocol: string;
        connectedAt: number; txBytes: number; rxBytes: number;
        pingMs: number; message: string;
      }[];
    }> = {};

    for (const c of allClients) {
      if (!c.room) continue;
      if (!byRoom[c.room]) {
        byRoom[c.room] = {
          room:     c.room,
          locked:   !!this.roomLocks.get(c.room),
          lockedBy: this.roomLocks.get(c.room) ?? "",
          clients:  [],
        };
      }
      byRoom[c.room].clients.push({
        id: c.id, name: c.name, protocol: c.protocol,
        connectedAt: c.connectedAt, txBytes: c.txBytes,
        rxBytes: c.rxBytes, pingMs: c.pingMs, message: c.message,
      });
    }

    const remoteList = Array.from(this.remoteConns.values()).map(r => ({ ...r }));

    return {
      enabled:      this._enabled,
      startedAt:    this._startedAt,
      uptimeMs:     now - this._startedAt,
      totalClients: allClients.length,
      inRoom:       allClients.filter(c => c.room).length,
      rooms:        Object.values(byRoom).sort((a, b) => a.room.localeCompare(b.room)),
      remoteConnections: remoteList,
    };
  }

  getAllClients(): ClientInfo[] {
    return Array.from(this.clients.values());
  }

  /** Legacy */
  getStats() {
    return {
      totalClients: this.clients.size,
      rooms: Array.from(this.rooms.entries()).map(([room, ids]) => ({
        room, count: ids.size, locked: !!this.roomLocks.get(room),
      })),
    };
  }
}

export const roomManager = new RoomManager();
