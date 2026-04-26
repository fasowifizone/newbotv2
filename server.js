const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const rateLimit = require('express-rate-limit');

const app = express();

// Configuration CORS - Permet à ton site https://newbotv1-2ktt.onrender.com d'accéder à l'API
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

// Rate limiting pour éviter les abus
const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 requêtes max par minute
    message: { error: 'Trop de requêtes, veuillez réessayer dans une minute' }
});

app.use('/api/send', limiter);

// Variables d'état
let client = null;
let isReady = false;
let currentQR = null;
let qrCodeGenerated = false;
let statusMessage = 'initializing';

// Configuration du client WhatsApp
function initializeClient() {
    console.log('🚀 Initialisation du client WhatsApp...');
    
    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: '/tmp/session'  // Utiliser /tmp car Render a un système de fichiers éphémère
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
                '--disable-gpu'
            ]
        }
    });

    // Événement QR Code
    client.on('qr', async (qr) => {
        console.log('📱 Nouveau QR code reçu');
        currentQR = qr;
        qrCodeGenerated = true;
        statusMessage = 'qr_ready';
        
        // Générer l'image base64 pour le frontend
        try {
            const qrImage = await QRCode.toDataURL(qr);
            currentQRImage = qrImage;
        } catch (err) {
            console.error('Erreur génération image QR:', err);
        }
    });

    // Événement authentification réussie
    client.on('authenticated', () => {
        console.log('✅ Authentification réussie !');
        statusMessage = 'authenticated';
    });

    // Événement client prêt
    client.on('ready', () => {
        console.log('🎉 Client WhatsApp prêt !');
        isReady = true;
        statusMessage = 'ready';
        qrCodeGenerated = false;
        currentQR = null;
    });

    // Événement déconnexion
    client.on('disconnected', (reason) => {
        console.log('❌ Client déconnecté:', reason);
        isReady = false;
        statusMessage = 'disconnected';
        currentQR = null;
        
        // Tentative de reconnexion après 5 secondes
        setTimeout(() => {
            if (!isReady) {
                console.log('🔄 Tentative de reconnexion...');
                client.initialize();
            }
        }, 5000);
    });

    // Événement échec d'authentification
    client.on('auth_failure', (msg) => {
        console.error('❌ Échec authentification:', msg);
        statusMessage = 'auth_failure';
        isReady = false;
    });

    // Démarrer le client
    client.initialize();
}

// Variable pour stocker l'image QR en base64
let currentQRImage = null;

// Initialisation
initializeClient();

// ============ ROUTES API ============

// Route racine - Info API
app.get('/', (req, res) => {
    res.json({
        name: 'WhatsApp API Server',
        version: '2.0.0',
        status: statusMessage,
        ready: isReady,
        endpoints: {
            'GET /api/status': 'Vérifier le statut de connexion',
            'GET /api/qr': 'Obtenir le QR code (format JSON avec base64)',
            'POST /api/send': 'Envoyer un message',
            'GET /api/info': 'Obtenir les infos du compte'
        }
    });
});

// Route 1: Vérifier le statut
app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        ready: isReady,
        status: statusMessage,
        qrAvailable: qrCodeGenerated && !isReady,
        timestamp: new Date().toISOString()
    });
});

// Route 2: Obtenir le QR code
app.get('/api/qr', async (req, res) => {
    if (isReady) {
        return res.json({
            success: true,
            ready: true,
            message: 'Déjà connecté, aucun QR code nécessaire',
            status: 'authenticated'
        });
    }
    
    if (currentQRImage) {
        // Extraire le base64 sans le préfixe data:image
        const base64Data = currentQRImage.split(',')[1];
        res.json({
            success: true,
            ready: false,
            qrCode: base64Data,
            qrImageUrl: currentQRImage,
            status: 'qr_ready'
        });
    } else if (currentQR) {
        // Générer l'image à la volée
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
            res.status(500).json({
                success: false,
                error: 'Erreur génération QR code'
            });
        }
    } else {
        res.json({
            success: false,
            ready: false,
            message: 'QR code non disponible, veuillez réessayer',
            status: statusMessage
        });
    }
});

// Route 3: Envoyer un message
app.post('/api/send', async (req, res) => {
    const { phone, message } = req.body;
    
    // Validation
    if (!phone || !message) {
        return res.status(400).json({
            success: false,
            error: 'Les champs "phone" et "message" sont requis'
        });
    }
    
    if (!isReady) {
        return res.status(503).json({
            success: false,
            error: 'WhatsApp non connecté. Veuillez scanner le QR code d\'abord.',
            status: statusMessage
        });
    }
    
    // Nettoyer le numéro
    let cleanNumber = phone.toString().replace(/\s+/g, '');
    if (cleanNumber.startsWith('+')) {
        cleanNumber = cleanNumber.substring(1);
    }
    cleanNumber = cleanNumber.replace(/\D/g, '');
    
    if (cleanNumber.length < 10) {
        return res.status(400).json({
            success: false,
            error: 'Numéro invalide. Format: 33612345678 (France)'
        });
    }
    
    // Format WhatsApp: numéro@c.us
    const chatId = `${cleanNumber}@c.us`;
    
    try {
        console.log(`📤 Envoi du message à ${cleanNumber}...`);
        
        // Vérifier si le numéro est enregistré sur WhatsApp
        const isRegistered = await client.isRegisteredUser(chatId);
        if (!isRegistered) {
            return res.status(400).json({
                success: false,
                error: 'Ce numéro n\'est pas enregistré sur WhatsApp'
            });
        }
        
        // Envoyer le message
        await client.sendMessage(chatId, message);
        
        console.log(`✅ Message envoyé à ${cleanNumber}`);
        res.json({
            success: true,
            message: 'Message envoyé avec succès',
            to: cleanNumber,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Erreur envoi:', error);
        res.status(500).json({
            success: false,
            error: `Échec de l'envoi: ${error.message}`
        });
    }
});

// Route 4: Obtenir les infos du compte connecté
app.get('/api/info', async (req, res) => {
    if (!isReady || !client) {
        return res.json({
            success: false,
            ready: false,
            message: 'Non connecté à WhatsApp'
        });
    }
    
    try {
        const info = client.info;
        const user = client.info?.wid?.user;
        
        res.json({
            success: true,
            ready: true,
            account: {
                phoneNumber: user || null,
                platform: info?.platform || 'whatsapp',
                pushname: info?.pushname || null
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Route 5: Déconnexion (supprime la session)
app.post('/api/logout', async (req, res) => {
    if (!client) {
        return res.json({ success: false, error: 'Client non initialisé' });
    }
    
    try {
        await client.logout();
        isReady = false;
        statusMessage = 'logged_out';
        currentQR = null;
        currentQRImage = null;
        qrCodeGenerated = false;
        
        res.json({
            success: true,
            message: 'Déconnecté avec succès'
        });
        
        // Réinitialiser le client après déconnexion
        setTimeout(() => {
            if (!isReady) {
                initializeClient();
            }
        }, 2000);
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Health check pour Render
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Démarrer le serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Serveur API démarré sur le port ${PORT}`);
    console.log(`🔗 API disponible sur http://localhost:${PORT}`);
    console.log(`📱 WhatsApp client en initialisation...`);
});
