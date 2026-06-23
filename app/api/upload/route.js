import { NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { GridFSBucket } from 'mongodb';
import { mongoEnabled, getMongoDb } from '../../lib/mongo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
};

export async function POST(req) {
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length > 25 * 1024 * 1024) {
      return NextResponse.json({ error: 'File too large (max 25MB)' }, { status: 413 });
    }

    let ext = path.extname(file.name || '').toLowerCase();
    if (!ext) ext = EXT_BY_MIME[file.type] || '';
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    const mime = file.type || 'application/octet-stream';

    // Durable path: store in MongoDB GridFS so media survives server restarts.
    if (mongoEnabled()) {
      const db = await getMongoDb();
      const bucket = new GridFSBucket(db, { bucketName: 'media' });
      const id = await new Promise((resolve, reject) => {
        const up = bucket.openUploadStream(filename, { contentType: mime, metadata: { name: file.name || filename } });
        up.on('error', reject);
        up.on('finish', () => resolve(up.id.toString()));
        up.end(bytes);
      });
      return NextResponse.json({ url: `/media/${id}`, mime, name: file.name || filename, size: bytes.length });
    }

    // Local fallback: write to public/uploads (ephemeral on hosts without a disk).
    const dir = path.join(process.cwd(), 'public', 'uploads');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, filename), bytes);
    return NextResponse.json({ url: `/uploads/${filename}`, mime, name: file.name || filename, size: bytes.length });
  } catch (e) {
    console.error('[upload] error:', e);
    return NextResponse.json({ error: e.message || 'Upload failed' }, { status: 500 });
  }
}
