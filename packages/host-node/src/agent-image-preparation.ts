/** 宿主图片解码与准备；只接收已登记字节，不搜索路径或执行图片中的外部内容。 */
import sharp from 'sharp'
import { MAX_AGENT_IMAGE_PIXELS, MAX_AGENT_IMAGE_PREPARED_BYTES, MAX_AGENT_IMAGE_SOURCE_BYTES, MAX_AGENT_IMAGE_THUMBNAIL_BYTES } from '@axon/shared'
import type { AgentImagePreparationResult } from '@axon/shared'

function imageFormat(bytes: Buffer): 'png' | 'jpeg' | 'webp' | 'gif' {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'gif'
  throw new Error('图片只支持实际编码为 PNG、JPEG、WebP 或 GIF 的文件')
}

/** 限原件/像素、取首帧、校正方向并等比缩放；输出只含重编码像素，不保留 EXIF。 */
export async function prepareAgentImage(input: Uint8Array): Promise<AgentImagePreparationResult> {
  if (!input.byteLength || input.byteLength > MAX_AGENT_IMAGE_SOURCE_BYTES) throw new Error('图片原件超过 20 MiB 或为空')
  const bytes = Buffer.from(input), format = imageFormat(bytes)
  const options = { failOn: 'warning' as const, limitInputPixels: MAX_AGENT_IMAGE_PIXELS, pages: 1, page: 0 }
  const metadata = await sharp(bytes, options).metadata()
  if (metadata.format !== format || !metadata.width || !metadata.height
    || metadata.width * metadata.height > MAX_AGENT_IMAGE_PIXELS) throw new Error('图片格式、尺寸或像素上限无效')
  let edge = 4096
  // 优先保留透明像素；单张超预算时继续等比缩小，不悄悄只传路径或截断字节。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const image = sharp(bytes, options).autoOrient().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    const mediaType = metadata.hasAlpha ? 'image/png' as const : 'image/jpeg' as const
    const output = await (metadata.hasAlpha ? image.png({ compressionLevel: 8 }) : image.jpeg({ quality: 88, mozjpeg: true })).toBuffer({ resolveWithObject: true })
    if (output.data.length <= MAX_AGENT_IMAGE_PREPARED_BYTES) {
      const thumbnail = await sharp(output.data, options).resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' }).jpeg({ quality: 75 }).toBuffer({ resolveWithObject: true })
      if (thumbnail.data.length > MAX_AGENT_IMAGE_THUMBNAIL_BYTES) throw new Error('图片缩略图超过上限')
      return {
      bytes: output.data, originalMediaType: `image/${format}`, mediaType,
      width: output.info.width, height: output.info.height,
      thumbnail: { bytes: thumbnail.data, width: thumbnail.info.width, height: thumbnail.info.height },
      ...(format === 'gif' || (metadata.pages ?? 1) > 1 ? { note: '动画图片仅发送第一帧。' } : {}),
      }
    }
    edge = Math.floor(edge * 0.7)
  }
  throw new Error('图片处理后仍超过单张 5 MiB 上限，请缩小后重试')
}
