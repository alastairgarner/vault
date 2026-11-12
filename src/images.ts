import path from 'node:path';

export const MAX_IMAGE_BYTES = 1024 * 1024;
export const MAX_IMAGE_BASE64_LENGTH = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
export const imagePath = /\.(png|jpe?g|gif|webp)$/;

export const VAULT_ATTACHMENTS = 'ai/attachments/';

// `requirePrefix: false` is for the external assets root, where any contained path is allowed.
export function decodeImage(name: string, base64: string, { requirePrefix = true } = {}) {
  if (requirePrefix && !name.startsWith(VAULT_ATTACHMENTS)) throw new Error(`Images must be created inside root-relative lowercase ${VAULT_ATTACHMENTS}`);
  if (base64.length > MAX_IMAGE_BASE64_LENGTH) throw new Error('Image too large (max 1 MiB)');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.toString('base64') !== base64) throw new Error('Use canonical padded base64, without a data URL or whitespace');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Image too large (max 1 MiB)');
  // Signatures identify formats; this is not full image decoding or malware scanning.
  let mimeType: string;
  let extensions: string[];
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('latin1', 12, 16) === 'IHDR') {
    mimeType = 'image/png'; extensions = ['.png'];
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.subarray(-2).equals(Buffer.from([0xff, 0xd9]))) {
    mimeType = 'image/jpeg'; extensions = ['.jpg', '.jpeg'];
  } else if (bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(bytes.toString('latin1', 0, 6)) && bytes.at(-1) === 0x3b) {
    mimeType = 'image/gif'; extensions = ['.gif'];
  } else if (bytes.length >= 20 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) === bytes.length - 8 && bytes.toString('latin1', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('latin1', 12, 16))) {
    mimeType = 'image/webp'; extensions = ['.webp'];
  } else {
    throw new Error('Unsupported image signature; use PNG, JPEG, GIF or WebP (no SVG)');
  }
  if (!extensions.includes(path.extname(name))) throw new Error('Image extension must match its format (.png, .jpg, .jpeg, .gif or .webp)');
  return { bytes, mimeType };
}
