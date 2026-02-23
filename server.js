const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const multer = require('multer');
const { MongoClient, GridFSBucket } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ifthar';
let db;
const MAX_BACKUPS = 20;

// Local uploads dir (temporary, photos also stored in GridFS)
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ===================== MongoDB Helpers =====================

async function getDoc(key) {
    try {
        const doc = await db.collection('store').findOne({ _key: key });
        return doc ? doc.data : null;
    } catch (e) {
        console.error(`DB read error (${key}):`, e.message);
        return null;
    }
}

async function setDoc(key, data) {
    await db.collection('store').updateOne(
        { _key: key },
        { $set: { _key: key, data, updatedAt: new Date() } },
        { upsert: true }
    );
}

// ===================== Backup (in MongoDB) =====================

async function createBackup() {
    try {
        const settingsData = await getDoc('settings');
        const appData = await getDoc('appdata');
        if (!settingsData && !appData) return;
        const now = new Date();
        const ts = now.toISOString().replace(/[:.]/g, '-');
        const filename = `backup-${ts}.json`;
        await db.collection('backups').insertOne({
            filename,
            settings: settingsData,
            appdata: appData,
            created: now
        });
        // Keep only last MAX_BACKUPS
        const count = await db.collection('backups').countDocuments();
        if (count > MAX_BACKUPS) {
            const oldest = await db.collection('backups')
                .find().sort({ created: 1 }).limit(count - MAX_BACKUPS).toArray();
            const ids = oldest.map(b => b._id);
            await db.collection('backups').deleteMany({ _id: { $in: ids } });
        }
    } catch (e) {
        console.error('Backup error:', e.message);
    }
}

// ===================== Photo Storage (GridFS) =====================

function getGridFSBucket() {
    return new GridFSBucket(db, { bucketName: 'photos' });
}

async function uploadToGridFS(filePath, filename) {
    const bucket = getGridFSBucket();
    const stream = fs.createReadStream(filePath);
    const uploadStream = bucket.openUploadStream(filename);
    return new Promise((resolve, reject) => {
        stream.pipe(uploadStream)
            .on('finish', () => resolve(uploadStream.id))
            .on('error', reject);
    });
}

async function downloadFromGridFS(filename, res) {
    const bucket = getGridFSBucket();
    const files = await bucket.find({ filename }).toArray();
    if (!files.length) return false;
    bucket.openDownloadStreamByName(filename).pipe(res);
    return true;
}

async function deleteFromGridFS(filename) {
    const bucket = getGridFSBucket();
    const files = await bucket.find({ filename }).toArray();
    for (const file of files) {
        await bucket.delete(file._id);
    }
}

// ===================== Multer config =====================

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
    }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ===================== Middleware =====================

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.json({ limit: '10mb' }));

// ===================== Serve uploaded photos (from GridFS) =====================

app.get('/uploads/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        // Try local file first
        const localPath = path.join(UPLOADS_DIR, filename);
        if (fs.existsSync(localPath)) {
            return res.sendFile(localPath);
        }
        // Try GridFS
        const found = await downloadFromGridFS(filename, res);
        if (!found) {
            res.status(404).json({ error: 'File not found' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===================== Static / PWA =====================

app.get('/health', (req, res) => {
    res.json({ status: 'ok', db: db ? 'connected' : 'disconnected' });
});

app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'manifest.json'));
});
app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(path.join(__dirname, 'sw.js'));
});
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ===================== Settings API =====================

app.get('/api/settings', async (req, res) => {
    try {
        const data = await getDoc('settings');
        res.json(data);
    } catch (e) {
        res.json(null);
    }
});

app.post('/api/settings', async (req, res) => {
    try {
        await createBackup();
        await setDoc('settings', req.body);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===================== App Data API =====================

app.get('/api/data', async (req, res) => {
    try {
        const data = await getDoc('appdata');
        res.json(data);
    } catch (e) {
        res.json(null);
    }
});

app.post('/api/data', async (req, res) => {
    try {
        await createBackup();
        await setDoc('appdata', req.body);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===================== Backups API =====================

app.get('/api/backups', async (req, res) => {
    try {
        const backups = await db.collection('backups')
            .find()
            .sort({ created: -1 })
            .toArray();
        res.json(backups.map(b => ({
            filename: b.filename,
            size: JSON.stringify(b).length,
            created: b.created.toISOString()
        })));
    } catch (e) {
        res.json([]);
    }
});

app.post('/api/backups/restore/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        if (!filename.startsWith('backup-') || !filename.endsWith('.json')) {
            return res.status(400).json({ error: 'Invalid backup file' });
        }
        const backup = await db.collection('backups').findOne({ filename });
        if (!backup) {
            return res.status(404).json({ error: 'Backup not found' });
        }
        if (backup.settings) await setDoc('settings', backup.settings);
        if (backup.appdata) await setDoc('appdata', backup.appdata);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===================== Updates API =====================

app.get('/api/updates', async (req, res) => {
    try {
        const data = await getDoc('updates');
        res.json(data || []);
    } catch (e) {
        res.json([]);
    }
});

app.post('/api/updates', upload.single('photo'), async (req, res) => {
    try {
        const updates = (await getDoc('updates')) || [];
        const update = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
            staff: req.body.staff || 'Anonymous',
            message: req.body.message || '',
            type: req.body.type || 'general',
            day: parseInt(req.body.day) || 0,
            photo: null,
            timestamp: new Date().toISOString()
        };
        // Handle photo upload - save to GridFS for persistence
        if (req.file) {
            update.photo = '/uploads/' + req.file.filename;
            try {
                await uploadToGridFS(req.file.path, req.file.filename);
            } catch (e) {
                console.error('GridFS upload error:', e.message);
            }
        }
        updates.unshift(update);
        await setDoc('updates', updates);
        res.json({ ok: true, update });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/updates/:id', async (req, res) => {
    try {
        let updates = (await getDoc('updates')) || [];
        const update = updates.find(u => u.id === req.params.id);
        if (update && update.photo) {
            const filename = update.photo.replace('/uploads/', '');
            // Delete from local
            const localPath = path.join(UPLOADS_DIR, filename);
            if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
            // Delete from GridFS
            try { await deleteFromGridFS(filename); } catch (e) {}
        }
        updates = updates.filter(u => u.id !== req.params.id);
        await setDoc('updates', updates);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===================== Error Handlers =====================

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});

// ===================== Start Server =====================

async function start() {
    try {
        console.log('\n  Connecting to MongoDB...');
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db();
        console.log('  MongoDB connected successfully!\n');

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`  Ifthar Management Server running on port ${PORT}\n`);
            try {
                const interfaces = os.networkInterfaces();
                for (const name of Object.keys(interfaces)) {
                    for (const iface of interfaces[name]) {
                        if (iface.family === 'IPv4' && !iface.internal) {
                            console.log(`  Network: http://${iface.address}:${PORT}`);
                        }
                    }
                }
            } catch (e) {}
            console.log('');
        });
    } catch (e) {
        console.error('  Failed to connect to MongoDB:', e.message);
        console.error('  Set MONGODB_URI environment variable with your MongoDB Atlas connection string');
        process.exit(1);
    }
}

start();
