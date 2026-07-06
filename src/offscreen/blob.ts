// Pairing-blob codec (spec §6.2, Appendix C).
// JSON → CompressionStream("deflate-raw") → base64url, with hard caps
// enforced before AND after decompression (decompression-bomb guard).
// No chrome.* — usable from tests directly.

import { BLOB_MAX_ENC, BLOB_MAX_JSON, BLOB_TTL_S } from "../lib/constants.js"
import type { PairBlob } from "../lib/proto.js"
import { parsePairBlob } from "../lib/proto.js"
import type { ParseError, Result } from "../lib/types.js"
import { err, ok, parseError } from "../lib/types.js"

const base64urlEncode = (bytes: Uint8Array): string => {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "")
}

const base64urlDecode = (s: string): Result<Uint8Array, ParseError> => {
  if (!/^[A-Za-z0-9_-]*$/u.test(s)) return err(parseError("blob: not base64url"))
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/")
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return ok(bytes)
  } catch {
    return err(parseError("blob: base64 decode failed"))
  }
}

const compress = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Decompress with an output cap; abort as soon as the cap is exceeded. */
const decompressCapped = async (
  bytes: Uint8Array,
  capBytes: number,
): Promise<Result<Uint8Array, ParseError>> => {
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > capBytes) {
        await reader.cancel()
        return err(parseError("blob: decompressed too large"))
      }
      chunks.push(value)
    }
    const out = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      out.set(c, off)
      off += c.byteLength
    }
    return ok(out)
  } catch {
    return err(parseError("blob: decompress failed"))
  }
}

export const encodePairBlob = async (blob: PairBlob): Promise<string> => {
  const json = new TextEncoder().encode(JSON.stringify(blob))
  return base64urlEncode(await compress(json))
}

export type DecodeOpts = Readonly<{ nowMs: number; skipTtl?: boolean }>

/**
 * Full ingress path: length cap → base64url → capped inflate → JSON.parse →
 * schema guard → TTL check. The SDP string stays attacker-controlled input
 * until setRemoteDescription accepts it — callers must not interpolate it
 * into UI or logs.
 */
export const decodePairBlob = async (
  encoded: string,
  opts: DecodeOpts,
): Promise<Result<PairBlob, ParseError>> => {
  const trimmed = encoded.trim()
  if (trimmed.length === 0) return err(parseError("blob: empty"))
  if (trimmed.length > BLOB_MAX_ENC) return err(parseError("blob: encoded too long"))

  const bytes = base64urlDecode(trimmed)
  if (!bytes.ok) return bytes

  const inflated = await decompressCapped(bytes.value, BLOB_MAX_JSON)
  if (!inflated.ok) return inflated

  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(inflated.value))
  } catch {
    return err(parseError("blob: invalid json"))
  }

  const parsed = parsePairBlob(json)
  if (!parsed.ok) return parsed

  if (opts.skipTtl !== true) {
    const ageS = (opts.nowMs - parsed.value.ts) / 1000
    if (ageS > BLOB_TTL_S || ageS < -60) return err(parseError("blob: expired"))
  }
  return parsed
}

/** 8 base32 chars from crypto.getRandomValues (spec §14). */
export const randomId = (): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567"
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  let out = ""
  for (const b of bytes) out += alphabet[b % 32]
  return out
}
