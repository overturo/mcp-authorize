// Mints real receipts with a throwaway EdDSA key so verification scenarios
// exercise the signature path; the recorded corpus carries the placeholder
// `<TOKEN>` where a receipt would be.
import { generateKeyPairSync, sign as nodeSign } from "node:crypto"
import { bytesToBase64url, rawEd25519ToJwk, type JwksKey } from "@overturo/sdk"

export const ISSUER = "https://overturo.com"
export const AUDIENCE = "did:web:ledger.example.com"
export const KID = "oap-test-v1"

export interface Minter {
  jwks: JwksKey[]
  kid: string
  sign(claims: Record<string, unknown>): Promise<string>
  claims(overrides?: Record<string, unknown>): Record<string, unknown>
}

export async function createMinter(kid: string = KID): Promise<Minter> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const publicJwk = publicKey.export({ format: "jwk" }) as { x: string }
  const jwks = [rawEd25519ToJwk(kid, publicJwk.x)]
  const enc = (obj: object) => bytesToBase64url(new TextEncoder().encode(JSON.stringify(obj)))

  return {
    jwks,
    kid,
    async sign(claims) {
      const input = `${enc({ alg: "EdDSA", typ: "oap+jwt", kid })}.${enc(claims)}`
      const sig = nodeSign(null, Buffer.from(input, "utf8"), privateKey)
      return `${input}.${bytesToBase64url(new Uint8Array(sig))}`
    },
    claims(overrides = {}) {
      const now = Math.floor(Date.now() / 1000)
      return {
        iss: ISSUER,
        aud: AUDIENCE,
        iat: now - 5,
        exp: now + 60,
        jti: `n_${Math.random().toString(36).slice(2)}`,
        oap_ver: "1.0",
        grant_id: "ath_us_test",
        action: "write",
        scope: "payments:transfer",
        value: "10.00",
        currency: "USD",
        context_hash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
        record_id: "rec_us_test",
        single_use: true,
        ...overrides,
      }
    },
  }
}
