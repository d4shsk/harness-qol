// MCP's inline base64 images are NOT Harness ContentBlocks. Persist bytes before rendering.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const text = value => ({ type: 'text', text: String(value) });

export function isImageAttachment(ref) {
  return !!ref && typeof ref === 'object' && typeof ref.attachmentId === 'string' && !!ref.attachmentId
    && IMAGE_TYPES.has(ref.mediaType) && Number.isSafeInteger(ref.bytes) && ref.bytes > 0
    && Number.isSafeInteger(ref.width) && ref.width > 0 && Number.isSafeInteger(ref.height) && ref.height > 0;
}

export function needsMcpImageRepair(block) {
  return !!block && block.type === 'image' && !isImageAttachment(block.attachment);
}

function imageUnavailable(reason) {
  return text(`[MCP image unavailable: ${reason}. Text results are preserved; request a new screenshot if needed.]`);
}

export async function admitMcpImage(block, attachments, signal) {
  signal?.throwIfAborted();
  if (isImageAttachment(block.attachment)) return { type: 'image', attachment: block.attachment };
  if (!attachments?.saveImage) return imageUnavailable('attachment storage is not available');
  const mediaType = block.mimeType || block.mediaType;
  if (!IMAGE_TYPES.has(mediaType)) return imageUnavailable('unsupported or missing image media type');
  const data = block.data;
  const maxBytes = attachments.imageLimits?.maxImageBytes || 20 * 1024 * 1024;
  if (typeof data !== 'string' || !data || data.length > Math.ceil(maxBytes / 3) * 4) return imageUnavailable('missing or oversized image bytes');
  // Buffer.from silently accepts invalid base64; reject it before saving anything.
  if (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return imageUnavailable('invalid base64 encoding');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== data) return imageUnavailable('invalid or oversized image bytes');
  try {
    // The provider validates raster bytes, dimensions and the deployment's image policy.
    const attachment = await attachments.saveImage({ data: bytes, mediaType });
    signal?.throwIfAborted();
    if (!isImageAttachment(attachment)) return imageUnavailable('storage returned an invalid attachment reference');
    return { type: 'image', attachment };
  } catch (error) {
    signal?.throwIfAborted();
    // Do not echo untrusted binary data or provider internals back into the context.
    return imageUnavailable('image validation or storage failed');
  }
}

export async function admitMcpResult(result, attachments, signal) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) return result;
  const content = [];
  let images = 0, encodedBytes = 0;
  const limits = attachments?.imageLimits;
  for (const block of result.content) {
    signal?.throwIfAborted();
    if (block?.type !== 'image') { content.push(block); continue; }
    images++;
    encodedBytes += typeof block.data === 'string' ? Math.floor(block.data.length * 3 / 4) : block.attachment?.bytes || 0;
    if (images > (limits?.maxImagesPerMessage || 20) || encodedBytes > (limits?.maxMessageImageBytes || 50 * 1024 * 1024)) {
      content.push(imageUnavailable('image batch exceeds the attachment policy'));
      continue;
    }
    content.push(await admitMcpImage(block, attachments, signal));
  }
  return { ...result, content };
}

export function renderMcpResult(_args, value) {
  if (typeof value === 'string') return [text(value)];
  if (value && typeof value === 'object' && Array.isArray(value.content)) {
    return value.content.map(block => {
      if (!block || typeof block !== 'object') return text('[Invalid MCP content block omitted]');
      if (block.type === 'text') return typeof block.text === 'string' ? text(block.text) : text('[Invalid MCP text block omitted]');
      if (block.type === 'image') return isImageAttachment(block.attachment)
        ? { type: 'image', attachment: block.attachment }
        : imageUnavailable('inline image was not admitted to attachment storage');
      if (block.type === 'resource' && typeof block.resource?.text === 'string') return text(block.resource.text);
      if (block.type === 'resource_link') return text(`MCP resource: ${block.name || ''} ${block.uri || ''}`);
      // Audio/blobs/unknown extensions must never masquerade as Harness image/file blocks.
      if (block.data || block.resource?.blob) return text(`[MCP ${block.type || 'binary'} content omitted: unsupported media]`);
      return text(JSON.stringify(block));
    });
  }
  return [text(JSON.stringify(value ?? null, null, 2))];
}
