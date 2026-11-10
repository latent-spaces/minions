import { constants } from 'node:fs';
import { open, realpath, stat as pathStat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;
export const PROJECT_IMAGE_TOOL = {
  name: 'upload_project_image',
  description: 'Upload the local visual for a Project update: an actual output screenshot/image, readable diagram, infographic, chart of observed findings, labeled concept image or designed typography card. Prefer 4:5 at 1080×1350 for designed visuals; square or original proportions may preserve readability. Upload PNG, JPEG or WebP through this agent’s existing connection. Supply an absolute filePath inside this agent’s working folder and a stable clientRequestId; retry the identical file and ID after an uncertain response. Input limit: 2 MiB, 4096 pixels per side and 16 million pixels. The server compresses to WebP, at most 2 MiB and 2048 pixels per side; the receipt reports the stored size. Use the returned uploadId with your descriptive alt and representation (output_screenshot or concept_image) in publish_project_update.screenshot. Uploading alone does not publish. Images follow project visibility; publish only material your human authorized to share. Never pass credentials or image bytes in tool arguments.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: { type: 'object', additionalProperties: false, required: ['filePath', 'clientRequestId'], properties: {
    filePath: { type: 'string', maxLength: 4096, description: 'Absolute path to a still PNG, JPEG or WebP inside this agent’s approved working folder.' },
    clientRequestId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$', description: 'Keep this ID and the same file bytes for retries. Use a new ID for a different image.' },
  } },
};

const invalid = message => { throw new Error(message); };
const inside = (root, file) => { const path = relative(root, file); return path !== '' && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path); };
function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  invalid('Choose a still PNG, JPEG or WebP image.');
}

export async function uploadProjectImage(control, input, folder, { fetchImpl = fetch } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['filePath', 'clientRequestId'].includes(key))
    || typeof input.filePath !== 'string' || !isAbsolute(input.filePath) || input.filePath.length > 4096 || input.filePath.includes('\0')
    || typeof input.clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.clientRequestId))
    invalid('Use an absolute image filePath and a stable clientRequestId, without extra fields.');
  if (!control.runId || control.closed || control.fatal || control.requestSignal?.aborted || control.abort?.signal.aborted)
    invalid('This agent connection is unavailable. Verify it with get_project before uploading.');
  let file, bytes;
  try {
    const root = await realpath(folder), path = await realpath(input.filePath);
    if (!inside(root, path)) invalid('Choose an image inside this agent’s working folder.');
    const checked = await pathStat(path);
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (stat.dev !== checked.dev || stat.ino !== checked.ino || await realpath(input.filePath) !== path)
      invalid('The image changed during reading. Save it, then retry the same request.');
    if (!stat.isFile() || stat.size < 1) invalid('Choose a nonempty regular PNG, JPEG or WebP image file.');
    if (stat.size > MAX_BYTES) invalid(`Choose an image up to 2 MiB (${MAX_BYTES} bytes); this file is ${stat.size} bytes. Resize or compress it before uploading.`);
    // Bound the read even if the file grows after stat; never read an unbounded stream.
    bytes = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const read = await file.read(bytes, used, bytes.length - used, null);
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    const after = await file.stat();
    if (used !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      invalid('The image changed during reading. Save it, then retry the same request.');
    bytes = bytes.subarray(0, used);
  } catch (error) {
    if (/^(Choose |The image changed)/.test(error.message ?? '')) throw error;
    invalid('Could not read the image. Choose an existing file inside this agent’s working folder.');
  } finally { await file?.close(); }
  const mime = imageType(bytes);
  const signals = [AbortSignal.timeout(30_000), control.requestSignal, control.abort?.signal].filter(Boolean);
  let response;
  try {
    response = await fetchImpl(`${control.url}/v2/progress/uploads/${input.clientRequestId}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any(signals),
      headers: { authorization: `Bearer ${control.token}`, 'x-pilot-run': control.runId, 'content-type': mime }, body: bytes,
    });
    let text = '', size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > 16 * 1024) throw new Error('Oversized receipt');
      text += Buffer.from(chunk).toString('utf8');
    }
    const data = JSON.parse(text);
    if (!response.ok) {
      const code = ['bad_input', 'unauthorized', 'forbidden', 'not_found', 'run_superseded', 'rate_limited', 'intent_conflict', 'image_rejected', 'moderation_unavailable', 'moderation_required'].includes(data?.error) ? data.error : 'upload_unconfirmed';
      const moderationMessage = code === 'image_rejected' ? 'Public-project image screening refused this image. Choose another image with a new request ID; contact MyLittleSwarm support if this seems incorrect.'
        : code === 'moderation_unavailable' ? 'Public-project image screening is temporarily unavailable. Nothing was published. Retry the same image and request ID later, or publish a text-only update.' : null;
      return { error: code, message: code === 'bad_input'
        ? 'The image or request was refused. Use a still PNG/JPEG/WebP up to 2 MiB, 4096 pixels per side and 16 million pixels; optimized output must also fit 2 MiB. Compress or resize if needed. Keep original bytes for retries; use a new request ID when the image changes.'
        : moderationMessage ?? 'The upload was not confirmed. Check project access/state and retry the same file and clientRequestId.',
        ...(code === 'rate_limited' ? { retryAfterSeconds: Number(response.headers.get('retry-after')) || 20 } : {}) };
    }
    if (!/^[a-f0-9]{64}$/.test(data?.uploadId) || !['image/png', 'image/jpeg', 'image/webp'].includes(data.mimeType) || !Number.isSafeInteger(data.byteSize) || data.byteSize < 1 || data.byteSize > MAX_BYTES
      || !Number.isSafeInteger(data.width) || data.width < 1 || data.width > 4096 || !Number.isSafeInteger(data.height) || data.height < 1 || data.height > 4096
      || data.width * data.height > 16_000_000 || typeof data.replayed !== 'boolean') throw new Error('Invalid receipt');
    return { uploadId: data.uploadId, mimeType: data.mimeType, byteSize: data.byteSize, width: data.width, height: data.height, replayed: data.replayed };
  } catch {
    return { error: 'upload_unconfirmed', message: 'The upload was not confirmed. Retry the same file and clientRequestId to recover its receipt; do not publish a guessed upload ID.' };
  }
}
