import {
  Input, BlobSource, MP4, QTFF, WEBM, MATROSKA, MP3, WAVE, FLAC, OGG,
  Output, BufferTarget, Mp4OutputFormat, MovOutputFormat, WebMOutputFormat, MkvOutputFormat,
  Mp3OutputFormat, WavOutputFormat, FlacOutputFormat, OggOutputFormat,
  EncodedAudioPacketSource, EncodedVideoPacketSource, EncodedPacketSink,
} from 'mediabunny'

/** Rebuild the container from audio/video packets, rather than copying a
 * file and trying to find every vendor tag. Do not copy track names, tags,
 * chapters, cover art, attachments or GPS/data tracks. Rotation is needed
 * to display the picture correctly. No remote decoder or upload is used. */
export async function cleanMedia(file: File, kind: string): Promise<Blob> {
  const input = new Input({ source: new BlobSource(file), formats: [MP4, QTFF, WEBM, MATROSKA, MP3, WAVE, FLAC, OGG] })
  const format = kind === 'mp4' ? /\.mov$/i.test(file.name) ? new MovOutputFormat() : new Mp4OutputFormat()
    : kind === 'webm' ? /\.mkv$/i.test(file.name) ? new MkvOutputFormat() : new WebMOutputFormat()
    : kind === 'mp3' ? new Mp3OutputFormat() : kind === 'wav' ? new WavOutputFormat()
    : kind === 'flac' ? new FlacOutputFormat() : new OggOutputFormat()
  const target = new BufferTarget(), output = new Output({ format, target })
  try {
    const video = await input.getVideoTracks(), audio = await input.getAudioTracks()
    if (!video.length && !audio.length || video.length + audio.length > 16) throw new Error('No supported media tracks.')
    const writers: (() => Promise<void>)[] = []
    for (const track of video) {
      const codec = await track.getCodec(), decoderConfig = await track.getDecoderConfig()
      if (!codec || !decoderConfig || !(await format.getSupportedVideoCodecs()).includes(codec)) throw new Error('Unsupported video codec.')
      const source = new EncodedVideoPacketSource(codec)
      output.addVideoTrack(source, { rotation: await track.getRotation(), flip: await track.getFlip() })
      writers.push(async () => {
        for await (const packet of new EncodedPacketSink(track).packets()) await source.add(packet, { decoderConfig })
        source.close()
      })
    }
    for (const track of audio) {
      const codec = await track.getCodec(), decoderConfig = await track.getDecoderConfig()
      if (!codec || !decoderConfig || !(await format.getSupportedAudioCodecs()).includes(codec)) throw new Error('Unsupported audio codec.')
      const source = new EncodedAudioPacketSource(codec)
      output.addAudioTrack(source)
      writers.push(async () => {
        for await (const packet of new EncodedPacketSink(track).packets()) await source.add(packet, { decoderConfig })
        source.close()
      })
    }
    output.setMetadataTags({})
    await output.start()
    await Promise.all(writers.map(write => write()))
    await output.finalize()
    if (!target.buffer || target.buffer.byteLength > 64 * 1024 * 1024) throw new Error('Cleaned media is too large.')
    return new Blob([target.buffer], { type: !video.length && kind === 'mp4' ? 'audio/mp4' : format.mimeType })
  } catch {
    await output.cancel().catch(() => {})
    throw new Error('This audio or video could not be cleaned safely. Nothing was uploaded. Export an MP4/WebM video or MP3/WAV audio copy and try again.')
  } finally { input.dispose() }
}
