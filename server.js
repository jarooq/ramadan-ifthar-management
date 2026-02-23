const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const APPDATA_FILE = path.join(DATA_DIR, 'appdata.json');
const UPDATES_FILE = path.join(DATA_DIR, 'updates.json');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Multer config for photo uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
    }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Allow cross-origin requests (needed for file:// migration)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.json({ limit: '10mb' }));

// Serve uploaded photos
app.use('/uploads', express.static(UPLOADS_DIR));

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Serve index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// GET /api/settings
app.get('/api/settings', (req, res) => {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            res.json(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
        } else {
            res.json(null);
        }
    } catch (e) {
        res.json(null);
    }
});

// POST /api/settings
app.post('/api/settings', (req, res) => {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(req.body, null, 2));
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/data
app.get('/api/data', (req, res) => {
    try {
        if (fs.existsSync(APPDATA_FILE)) {
            res.json(JSON.parse(fs.readFileSync(APPDATA_FILE, 'utf8')));
        } else {
            res.json(null);
        }
    } catch (e) {
        res.json(null);
    }
});

// POST /api/data
app.post('/api/data', (req, res) => {
    try {
        fs.writeFileSync(APPDATA_FILE, JSON.stringify(req.body, null, 2));
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/data - disabled for data protection

// ===================== UPDATES API =====================

function readUpdates() {
    try {
        if (fs.existsSync(UPDATES_FILE)) {
            return JSON.parse(fs.readFileSync(UPDATES_FILE, 'utf8'));
        }
    } catch (e) {}
    return [];
}

function writeUpdates(updates) {
    fs.writeFileSync(UPDATES_FILE, JSON.stringify(updates, null, 2));
}

// GET /api/updates
app.get('/api/updates', (req, res) => {
    res.json(readUpdates());
});

// POST /api/updates - create update with optional photo
app.post('/api/updates', upload.single('photo'), (req, res) => {
    try {
        const updates = readUpdates();
        const update = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
            staff: req.body.staff || 'Anonymous',
            message: req.body.message || '',
            type: req.body.type || 'general',
            day: parseInt(req.body.day) || 0,
            photo: req.file ? '/uploads/' + req.file.filename : null,
            timestamp: new Date().toISOString()
        };
        updates.unshift(update); // newest first
        writeUpdates(updates);
        res.json({ ok: true, update });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/updates/:id
app.delete('/api/updates/:id', (req, res) => {
    try {
        let updates = readUpdates();
        const update = updates.find(u => u.id === req.params.id);
        if (update && update.photo) {
            const photoPath = path.join(__dirname, 'data', update.photo);
            if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
        }
        updates = updates.filter(u => u.id !== req.params.id);
        writeUpdates(updates);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Ifthar Management Server running on port ${PORT}\n`);
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
