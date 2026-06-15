import crypto from 'node:crypto'

const MAGIC = Buffer.from('HETY2')
const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16

function deriveKey(password: string, salt: Buffer): Buffer {
  // scrypt with defaults (N=16384, r=8, p=1) ~ 16MB, fine for a desktop unlock.
  return crypto.scryptSync(password, salt, 32)
}

export function hasMagic(buf: Buffer): boolean {
  return buf.length > MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC)
}

export function isEncrypted(buf: Buffer): boolean {
  return hasMagic(buf) && buf[MAGIC.length] === 1
}

/** Layout: [MAGIC][flag=1][salt(16)][iv(12)][tag(16)][ciphertext] */
export function encrypt(plaintext: Buffer, password: string): Buffer {
  const salt = crypto.randomBytes(SALT_LEN)
  const iv = crypto.randomBytes(IV_LEN)
  const key = deriveKey(password, salt)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([MAGIC, Buffer.from([1]), salt, iv, tag, enc])
}

/** Layout: [MAGIC][flag=0][plaintext] */
export function packPlain(plaintext: Buffer): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([0]), plaintext])
}

export function decrypt(buf: Buffer, password: string): Buffer {
  if (!hasMagic(buf)) throw new Error('Not a Hety data file.')
  const flag = buf[MAGIC.length]
  let off = MAGIC.length + 1
  if (flag === 0) return buf.subarray(off)

  const salt = buf.subarray(off, off + SALT_LEN); off += SALT_LEN
  const iv = buf.subarray(off, off + IV_LEN); off += IV_LEN
  const tag = buf.subarray(off, off + TAG_LEN); off += TAG_LEN
  const ciphertext = buf.subarray(off)

  const key = deriveKey(password, salt)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new Error('Wrong password or corrupted data file.')
  }
}
