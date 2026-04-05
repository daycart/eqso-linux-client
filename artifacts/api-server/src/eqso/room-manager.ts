import { EventEmitter } from "events";

export interface ClientInfo {
  id: string;
  name: string;
  room: string;
  message: string;
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

    if (client.room) {
      this.leaveRoom(id);
    }
    this.clients.delete(id);
  }

  joinRoom(clientId: string, room: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;

    const oldRoom = client.room;
    if (oldRoom && oldRoom !== room) {
      this.leaveRoom(clientId);
    }

    if (!this.rooms.has(room)) {
      this.rooms.set(room, new Set());
    }

    this.rooms.get(room)!.add(clientId);
    client.room = room;

    this.emit("event", {
      type: "join",
      clientId,
      name: client.name,
      room,
    } as RoomEvent);

    return true;
  }

  leaveRoom(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client || !client.room) return;

    const room = client.room;
    const members = this.rooms.get(room);
    if (members) {
      members.delete(clientId);
      if (members.size === 0) {
        this.rooms.delete(room);
      }
    }

    if (this.roomLocks.get(room) === clientId) {
      this.roomLocks.delete(room);
    }

    this.emit("event", {
      type: "leave",
      clientId,
      name: client.name,
      room,
    } as RoomEvent);

    client.room = "";
  }

  tryLockRoom(room: string, clientId: string): boolean {
    const existing = this.roomLocks.get(room);
    if (existing && existing !== clientId) return false;
    this.roomLocks.set(room, clientId);
    return true;
  }

  unlockRoom(room: string, clientId: string): void {
    if (this.roomLocks.get(room) === clientId) {
      this.roomLocks.delete(room);
    }
  }

  broadcastToRoom(
    room: string,
    data: Buffer,
    excludeId?: string
  ): void {
    const members = this.rooms.get(room);
    if (!members) return;
    for (const id of members) {
      if (id === excludeId) continue;
      const c = this.clients.get(id);
      if (c) {
        try {
          c.send(data);
        } catch {
        }
      }
    }
  }

  broadcastToAll(data: Buffer, excludeId?: string): void {
    for (const [id, c] of this.clients) {
      if (id === excludeId) continue;
      try {
        c.send(data);
      } catch {
      }
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

  getStats() {
    return {
      totalClients: this.clients.size,
      rooms: Array.from(this.rooms.entries()).map(([room, ids]) => ({
        room,
        count: ids.size,
        locked: !!this.roomLocks.get(room),
      })),
    };
  }
}

export const roomManager = new RoomManager();
