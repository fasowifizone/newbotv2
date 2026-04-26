const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const rateLimit = require('express-rate-limit');

const app = express();

// Configuration CORS
app.use(cors({
    origin: [
        'https://newbotv1-2ktt.onrender.com',
        'http://localhost:3000',
        'http://localhost:5500'
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// Rate limiting
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: 'Trop de requêtes' }
});
app.use('/api/send', limiter);

// Variables d'état
let client = null;
let isReady = false;
let currentQR = null;
let currentQRImage = null;
let statusMessage = 'initializing';

// Configuration spécifique pour Render
const clientConfig = {
    authStrategy: new LocalAuth({
        dataPath: '/tmp/session'
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process'
        ],
        // Configuration importante pour Render
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null
    }
};

function initializeClient() {
    console.log('🚀 Initialisation du client WhatsApp...');
    
    client = new Client(clientConfig);

    client.on('qr', async (qr) => {
        console.log('📱 Nouveau QR code reçu');
        currentQR = qr;
        statusMessage = 'qr_ready';
        try {
            currentQRImage = await QRCode.toDataURL(qr);
        } catch (err) {
            console.error('Erreur génération QR:', err);
        }
    });

    client.on('authenticated', () => {
        console.log('✅ Authentification réussie !');
        statusMessage = 'authenticated';
    });

    client.on('ready', () => {
        console.log('🎉 Client WhatsApp prêt !');
        isReady = true;
        statusMessage = 'ready';
        currentQR = null;
        currentQRImage = null;
    });

    client.on('disconnected', (reason) => {
        console.log('❌ Client déconnecté:', reason);
        isReady = false;
        statusMessage = 'disconnected';
        setTimeout(() => {
            if (!isReady) client.initialize();
        }, 5000);
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ Échec authentification:', msg);
        statusMessage = 'auth_failure';
        isReady = false;
    });

    client.initialize();
}

initializeClient();

// Routes API
app.get('/', (req, res) => {
    res.json({
        name: 'WhatsApp API Server',
        version: '2.0.0',
        status: statusMessage,
        ready: isReady,
        endpoints: {
            'GET /api/status': 'Vérifier le statut',
            'GET /api/qr': 'Obtenir QR code',
            'POST /api/send': 'Envoyer message',
            'GET /api/info': 'Infos compte'
        }
    });
});

app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        ready: isReady,
        status: statusMessage,
        qrAvailable: !!currentQR && !isReady,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/qr', async (req, res) => {
    if (isReady) {
        return res.json({
            success: true,
            ready: true,
            message: 'Déjà connecté'
        });
    }
    
    if (currentQRImage) {
        const base64Data = currentQRImage.split(',')[1];
        res.json({
            success: true,
            ready: false,
            qrCode: base64Data,
            qrImageUrl: currentQRImage,
            status: 'qr_ready'
        });
    } else if (currentQR) {
        try {
            const qrImage = await QRCode.toDataURL(currentQR);
            const base64Data = qrImage.split(',')[1];
            res.json({
                success: true,
                ready: false,
                qrCode: base64Data,
                qrImageUrl: qrImage,
                status: 'qr_ready'
            });
        } catch (err) {
            res.status(500).json({ success: false, error: 'Erreur génération QR' });
        }
    } else {
        res.json({
            success: false,
            ready: false,
            message: 'QR code non disponible',
            status: statusMessage
        });
    }
});

app.post('/api/send', async (req, res) => {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
        return res.status(400).json({ success: false, error: 'Phone et message requis' });
    }
    
    if (!isReady) {
        return res.status(503).json({ success: false, error: 'WhatsApp non connecté' });
    }
    
    let cleanNumber = phone.toString().replace(/\s+/g, '');
    if (cleanNumber.startsWith('+')) cleanNumber = cleanNumber.substring(1);
    cleanNumber = cleanNumber.replace(/\D/g, '');
    
    if (cleanNumber.length < 10) {
        return res.status(400).json({ success: false, error: 'Numéro invalide' });
    }
    
    const chatId = `${cleanNumber}@c.us`;
    
    try {
        await client.sendMessage(chatId, message);
        res.json({ success: true, message: 'Message envoyé', to: cleanNumber });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/info', async (req, res) => {
    if (!isReady) {
        return res.json({ success: false, ready: false });
    }
    res.json({
        success: true,
        account: { phoneNumber: client.info?.wid?.user || null }
    });
});

app.post('/api/logout', async (req, res) => {
    if (!client) return res.json({ success: false });
    try {
        await client.logout();
        isReady = false;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.get('/health', (req, res) => res.status(200).send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Serveur démarré sur le port ${PORT}`);
});
