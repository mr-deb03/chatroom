import { GridFSBucket, ObjectId } from 'mongodb';
import { Readable } from 'stream';
import { getMongoDb } from '../../lib/mongo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Streams an uploaded image / voice note back from MongoDB GridFS.
export async function GET(req, { params }) {
  const db = await getMongoDb();
  if (!db) return new Response('Storage not configured', { status: 404 });

  let _id;
  try {
    _id = new ObjectId(params.id);
  } catch {
    return new Response('Bad id', { status: 400 });
  }

  const files = await db.collection('media.files').find({ _id }).limit(1).toArray();
  if (!files.length) return new Response('Not found', { status: 404 });
  const f = files[0];

  const bucket = new GridFSBucket(db, { bucketName: 'media' });
  const webStream = Readable.toWeb(bucket.openDownloadStream(_id));

  return new Response(webStream, {
    headers: {
      'Content-Type': f.contentType || (f.metadata && f.metadata.mime) || 'application/octet-stream',
      'Content-Length': String(f.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
