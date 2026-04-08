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

export class RoomManager extends EventEmitter {
  private clients = new Map<string, ClientInfo>();
  private rooms = new Map<string, Set<string>>();
  private roomLocks = new Map<string, string>();
  private _enabled = true;
  private _startedAt = Date.now();
  private remoteConns = new Map<string, RemoteConnectionInfo>();

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

  unlockRoom(room: string, clientId: string): void {
    if (this.roomLocks.get(room) === clientId) this.roomLocks.delete(room);
  }

  broadcastToRoom(room: string, data: Buffer, excludeId?: string): void {
    const members = this.rooms.get(room);
    if (!members) return;
    for (const id of members) {
      if (id === excludeId) continue;
      const c = this.clients.get(id);
      if (c) {
        try {
          c.txBytes += data.length;
          c.send(data);
        } catch { /* ignore */ }
      }
    }
  }

  broadcastToAll(data: Buffer, excludeId?: string): void {
    for (const [id, c] of this.clients) {
      if (id === excludeId) continue;
      try {
        c.txBytes += data.length;
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
