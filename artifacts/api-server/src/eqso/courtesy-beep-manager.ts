import { spawn } from "child_process";
import { logger } from "../lib/logger";
import { db } from "@workspace/db";
import { systemSettingsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

const SAMPLE_RATE = 8000;
const AUDIO_PAYLOAD_SIZE = 198;

// Available courtesy tones
export const COURTESY_TONES: { id: string; label: string }[] = [
  { id: "beep-simple",   label: "Bip simple (1000 Hz, 200ms)" },
  { id: "beep-double",   label: "Doble bip (1000 Hz, 2x150ms)" },
  { id: "beep-descend",  label: "Tono descendente (1400 a 800 Hz)" },
  { id: "beep-roger",    label: "Roger bip (1750 Hz, 100ms)" },
  { id: "beep-cw-k",     label: "CW 'K' (700 Hz, dah-dit-dah)" },
];

// ── PCM generation ────────────────────────────────────────────────────────────

function sine(freq: number, durationMs: number, amp = 0.6): Int16Array {
  const n = Math.floor(SAMPLE_RATE * durationMs / 1000);
  const buf = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    buf[i] = Math.round(amp * 32767 * Math.sin(2 * Math.PI * freq * i / SAMPLE_RATE));
  }
  return buf;
}

function silence(durationMs: number): Int16Array {
  return new Int16Array(Math.floor(SAMPLE_RATE * durationMs / 1000));
}

function concat(...parts: Int16Array[]): Int16Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Int16Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function generatePcm(id: string): Int16Array {
  switch (id) {
    case "beep-simple":
      return sine(1000, 200);
    case "beep-double":
      return concat(sine(1000, 150), silence(100), sine(1000, 150));
    case "beep-descend": {
      const n = Math.floor(SAMPLE_RATE * 300 / 1000);
      const buf = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        const freq = 1400 - (600 * i / n);
        buf[i] = Math.round(0.6 * 32767 * Math.sin(2 * Math.PI * freq * i / SAMPLE_RATE));
      }
      return buf;
    }
    case "beep-roger":
      return concat(sine(1750, 200), silence(50));
    case "beep-cw-k":
      return concat(
        sine(700, 300), silence(100),
        sine(700, 100), silence(100),
        sine(700, 300),
      );
    default:
      return sine(1000, 200);
  }
}

function pcmToWav(pcm: Int16Array): Buffer {
  const dataLen = pcm.length * 2;
  const buf = Buffer.allocUnsafe(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < pcm.length; i++) {
    buf.writeInt16LE(pcm[i]!, 44 + i * 2);
  }
  return buf;
}

async function wavToGsmPackets(wavBuf: Buffer): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-i", "pipe:0",
      "-ar", "8000",
      "-ac", "1",
      "-f", "gsm",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    const chunks: Buffer[] = [];
    ff.stdout.on("data", (c: Buffer) => chunks.push(c));
    ff.stderr.on("data", () => {});
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code !== 0 && code !== null) { reject(new Error(`ffmpeg exit ${code}`)); return; }
      const raw = Buffer.concat(chunks);
      const packets: Buffer[] = [];
      for (let off = 0; off + AUDIO_PAYLOAD_SIZE <= raw.length; off += AUDIO_PAYLOAD_SIZE) {
        packets.push(Buffer.concat([Buffer.from([0x01]), raw.slice(off, off + AUDIO_PAYLOAD_SIZE)]));
      }
      resolve(packets);
    });
    ff.stdin.write(wavBuf);
    ff.stdin.end();
  });
}

// ── Manager class ─────────────────────────────────────────────────────────────

class CourtesyBeepManager {
  private tonePackets = new Map<string, Buffer[]>();
  private selectedId = "beep-simple";
  private _enabled = true;

  async init(): Promise<void> {
    // Load config from DB
    try {
      const rows = await db.select().from(systemSettingsTable);
      const map = new Map(rows.map(r => [r.key, r.value]));
      const savedId  = map.get("courtesy_beep_id");
      const savedEn  = map.get("courtesy_beep_enabled");
      if (savedId && COURTESY_TONES.find(t => t.id === savedId)) this.selectedId = savedId;
      if (savedEn !== undefined) this._enabled = savedEn === "1";
      logger.info({ selectedId: this.selectedId, enabled: this._enabled }, "CourtesyBeepManager: config loaded from DB");
    } catch (err) {
      logger.warn({ err }, "CourtesyBeepManager: could not load config from DB");
    }

    // Pre-generate all tones
    for (const tone of COURTESY_TONES) {
      try {
        const pcm  = generatePcm(tone.id);
        const wav  = pcmToWav(pcm);
        const pkts = await wavToGsmPackets(wav);
        this.tonePackets.set(tone.id, pkts);
        logger.info({ id: tone.id, packets: pkts.length }, "CourtesyBeepManager: tone ready");
      } catch (err) {
        logger.warn({ err, id: tone.id }, "CourtesyBeepManager: failed to generate tone");
      }
    }
  }

  getPackets(): Buffer[] {
    if (!this._enabled) return [];
    return this.tonePackets.get(this.selectedId) ?? [];
  }

  isEnabled():     boolean { return this._enabled; }
  getSelectedId(): string  { return this.selectedId; }

  getConfig() {
    return {
      enabled:    this._enabled,
      selectedId: this.selectedId,
      tones:      COURTESY_TONES,
    };
  }

  async setConfig(selectedId: string, enabled: boolean): Promise<void> {
    if (COURTESY_TONES.find(t => t.id === selectedId)) this.selectedId = selectedId;
    this._enabled = enabled;
    await this.persist();
    logger.info({ selectedId: this.selectedId, enabled: this._enabled }, "CourtesyBeepManager: config saved");
  }

  private async persist(): Promise<void> {
    await db.insert(systemSettingsTable)
      .values({ key: "courtesy_beep_id", value: this.selectedId })
      .onConflictDoUpdate({ target: systemSettingsTable.key, set: { value: sql`excluded.value` } });
    await db.insert(systemSettingsTable)
      .values({ key: "courtesy_beep_enabled", value: this._enabled ? "1" : "0" })
      .onConflictDoUpdate({ target: systemSettingsTable.key, set: { value: sql`excluded.value` } });
  }
}

export const courtesyBeepManager = new CourtesyBeepManager();
