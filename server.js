const express = require('express');
const { google } = require('googleapis');
const fetch = require('node-fetch');
const stream = require('stream');

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Variables d'environnement
const VERIFY_TOKEN = 'maau_academy_webhook_2024';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || '';
const N8N_SECRET = process.env.N8N_SECRET || '';

// ==================
// GOOGLE DRIVE SETUP (OAuth2)
// ==================
function getDriveClient() {
  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth: oauth2Client });
}

// Mapping numéro WhatsApp → élève + matière + prof
const ELEVES_MAPPING = {
  '237697251888': {
    nom: 'Alice_Morel',
    matieres: {
      default: { dossier: 'Maths_Prof_Kamga', prof: 'Prof_Kamga' }
    }
  },
  '237600000000': {
    nom: 'Bruno_Tagne',
    matieres: {
      default: { dossier: 'Anglais_Prof_Mballa', prof: 'Prof_Mballa' }
    }
  }
};

// Trouver ou créer un dossier dans Drive
async function findOrCreateFolder(drive, name, parentId) {
  const q = parentId
    ? `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
    : `name='${name}' and 'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;

  const res = await drive.files.list({ q, fields: 'files(id, name)' });

  if (res.data.files.length > 0) return res.data.files[0].id;

  const body = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) body.parents = [parentId];

  const folder = await drive.files.create({ requestBody: body, fields: 'id' });
  return folder.data.id;
}

// Upload fichier vers Drive
async function uploadToDrive(fileBuffer, fileName, mimeType, folderId) {
  const drive = getDriveClient();
  const bufferStream = new stream.PassThrough();
  bufferStream.end(fileBuffer);

  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType, body: bufferStream },
    fields: 'id, name, webViewLink'
  });

  return res.data;
}

// Télécharger fichier depuis Meta
async function downloadFromMeta(mediaId) {
  const urlRes = await fetch(
    `https://graph.facebook.com/v18.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
  const urlData = await urlRes.json();
  const fileRes = await fetch(urlData.url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
  });
  const buffer = await fileRes.buffer();
  return { buffer, mimeType: urlData.mime_type };
}

// Router le fichier vers le bon dossier Drive
async function routeFileToDrive(from, fileName, fileBuffer, mimeType) {
  const drive = getDriveClient();

  const eleve = ELEVES_MAPPING[from];
  const eleveNom = eleve ? eleve.nom : `Inconnu_${from}`;
  const matiereDossier = eleve ? eleve.matieres.default.dossier : 'Non_Assigne';
  const today = new Date().toISOString().split('T')[0];

  const rootId = await findOrCreateFolder(drive, 'MAAU_Academy', null);
  const elevesId = await findOrCreateFolder(drive, 'Eleves', rootId);
  const eleveId = await findOrCreateFolder(drive, eleveNom, elevesId);
  const matiereId = await findOrCreateFolder(drive, matiereDossier, eleveId);
  const dateId = await findOrCreateFolder(drive, today, matiereId);

  const uploaded = await uploadToDrive(fileBuffer, fileName, mimeType, dateId);
  console.log(`Fichier uploadé : ${uploaded.name} → ${uploaded.webViewLink}`);
  return uploaded;
}

// Stockage temporaire des messages
let messages = [];

// ==================
// WEBHOOK VERIFICATION (Meta)
// ==================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook vérifié');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ==================
// RECEPTION MESSAGES (Meta API officielle)
// ==================
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (value.messages) {
          for (const msg of value.messages) {
            const from = msg.from;
            const messageId = msg.id;
            const timestamp = new Date(parseInt(msg.timestamp) * 1000);
            const contact = value.contacts?.find(c => c.wa_id === from);
            const name = contact?.profile?.name || from;

            let content = '';
            let type = msg.type;
            let mediaId = null;
            let fileName = null;
            let mimeType = null;

            if (msg.type === 'text') {
              content = msg.text?.body || '';
            } else if (msg.type === 'image') {
              mediaId = msg.image?.id;
              mimeType = msg.image?.mime_type || 'image/jpeg';
              fileName = `image_${Date.now()}.jpg`;
              content = '[Image reçue]';
            } else if (msg.type === 'document') {
              mediaId = msg.document?.id;
              mimeType = msg.document?.mime_type || 'application/pdf';
              fileName = msg.document?.filename || `document_${Date.now()}.pdf`;
              content = `[Document reçu: ${fileName}]`;
            } else if (msg.type === 'audio') {
              mediaId = msg.audio?.id;
              mimeType = msg.audio?.mime_type || 'audio/ogg';
              fileName = `audio_${Date.now()}.ogg`;
              content = '[Note vocale reçue]';
            } else if (msg.type === 'video') {
              mediaId = msg.video?.id;
              mimeType = msg.video?.mime_type || 'video/mp4';
              fileName = `video_${Date.now()}.mp4`;
              content = '[Vidéo reçue]';
            } else {
              content = `[Message de type: ${msg.type}]`;
            }

            let driveLink = null;
            if (mediaId) {
              try {
                const { buffer } = await downloadFromMeta(mediaId);
                const uploaded = await routeFileToDrive(from, fileName, buffer, mimeType);
                driveLink = uploaded.webViewLink;
                content += ` → Drive: ${driveLink}`;
              } catch (err) {
                console.error('Erreur upload Drive:', err.message);
              }
            }

            const categorie = classifyMessage(content);
            messages.push({
              id: Date.now(), messageId, from, name, content, type,
              categorie, timestamp, statut: 'non-traite',
              assignedTo: '', reponse: '', driveLink,
              source: 'meta'
            });
            console.log(`[Meta] Message de ${name} (${from}): ${content}`);
          }
        }
      }
    }
  }
  res.sendStatus(200);
});

// ==================
// ENDPOINT N8N / GREEN API / WAHA
// ==================
app.post('/api/n8n/message', async (req, res) => {

  // Vérification clé API
  if (N8N_SECRET && req.headers['x-api-key'] !== N8N_SECRET) {
    console.log('Tentative non autorisée sur /api/n8n/message');
    return res.status(401).json({ success: false, error: 'Non autorisé' });
  }

  const body = req.body;

  // Ignorer les webhooks qui ne sont pas des messages entrants
  if (body.typeWebhook && body.typeWebhook !== 'incomingMessageReceived') {
    return res.status(200).json({ success: true, ignored: true });
  }

  const senderData  = body.senderData || {};
  const messageData = body.messageData || {};

  // Extraire les données expéditeur
  const chatId   = senderData.chatId || '';
  const sender   = senderData.sender?.replace('@c.us', '') || '';
  const name     = senderData.senderName || sender;
  const chatName = senderData.chatName || '';
  const isGroup  = chatId.includes('@g.us');

  // Extraire le contenu du message
  let content  = '';
  let type     = 'text';
  let mediaUrl = null;
  let fileName = null;
  let mimeType = null;

  const msgType = messageData.typeMessage || '';

  if (msgType === 'textMessage') {
    content = messageData.textMessageData?.textMessage || '';
    type    = 'text';

  } else if (msgType === 'imageMessage') {
    content  = '[Image reçue]';
    type     = 'image';
    mediaUrl = messageData.fileMessageData?.downloadUrl || null;
    fileName = `image_${Date.now()}.jpg`;
    mimeType = 'image/jpeg';

  } else if (msgType === 'documentMessage') {
    const fileData = messageData.fileMessageData || {};
    fileName = fileData.fileName || `document_${Date.now()}.pdf`;
    mimeType = fileData.mimeType || 'application/pdf';
    content  = `[Document reçu: ${fileName}]`;
    type     = 'document';
    mediaUrl = fileData.downloadUrl || null;

  } else if (msgType === 'audioMessage') {
    content  = '[Note vocale reçue]';
    type     = 'audio';
    mediaUrl = messageData.fileMessageData?.downloadUrl || null;
    fileName = `audio_${Date.now()}.ogg`;
    mimeType = 'audio/ogg';

  } else if (msgType === 'videoMessage') {
    content  = '[Vidéo reçue]';
    type     = 'video';
    mediaUrl = messageData.fileMessageData?.downloadUrl || null;
    fileName = `video_${Date.now()}.mp4`;
    mimeType = 'video/mp4';

  } else {
    content = `[Message de type: ${msgType}]`;
    type    = msgType;
  }

  // Upload vers Google Drive si fichier avec URL
  let driveLink = null;
  if (mediaUrl) {
    try {
      const response = await fetch(mediaUrl);
      const buffer   = await response.buffer();
      const uploaded = await routeFileToDrive(sender, fileName, buffer, mimeType);
      driveLink      = uploaded.webViewLink;
      content       += ` → Drive: ${driveLink}`;
      console.log(`[n8n] Fichier de ${name} uploadé: ${driveLink}`);
    } catch (err) {
      console.error('[n8n] Erreur upload Drive:', err.message);
    }
  }

  const categorie = classifyMessage(content);

  const newMessage = {
    id         : Date.now(),
    messageId  : `n8n_${Date.now()}`,
    from       : sender,
    name       : name,
    chatId     : chatId,
    chatName   : chatName,
    isGroup    : isGroup,
    content    : content,
    type       : type,
    categorie  : categorie,
    timestamp  : new Date(),
    statut     : 'non-traite',
    assignedTo : '',
    reponse    : '',
    driveLink  : driveLink,
    source     : 'n8n'
  };

  messages.push(newMessage);
  console.log(`[n8n] Message de ${name} (${sender})${isGroup ? ` dans groupe "${chatName}"` : ''}: ${content}`);

  res.json({ success: true, messageId: newMessage.id });
});

// ==================
// CLASSIFICATION
// ==================
function classifyMessage(content) {
  const lower = content.toLowerCase();
  if (lower.includes('urgent') || lower.includes('problème') || lower.includes('aide') || lower.includes('bloqué')) return 'urgent';
  if (lower.includes('paiement') || lower.includes('facture') || lower.includes('payer') || lower.includes('tarif')) return 'financier';
  if (lower.includes('cours') || lower.includes('séance') || lower.includes('rattrapage') || lower.includes('absent')) return 'pedagogique';
  if (lower.includes('connexion') || lower.includes('meet') || lower.includes('lien') || lower.includes('technique')) return 'operationnel';
  if (lower.includes('annul') || lower.includes('contrat')) return 'cadre';
  if (lower.includes('mécontent') || lower.includes('insatisfait') || lower.includes('plainte')) return 'relation';
  return 'commercial';
}

// ==================
// API TABLEAU DE BORD
// ==================
app.get('/api/messages', (req, res) => {
  res.json({ success: true, messages });
});

app.post('/api/reply', async (req, res) => {
  const { to, message, messageId } = req.body;
  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: message } })
      }
    );
    const data = await response.json();
    const msg = messages.find(m => m.id === messageId);
    if (msg) { msg.statut = 'traite'; msg.reponse = message; }
    res.json({ success: true, data });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/messages/:id/done', (req, res) => {
  const msg = messages.find(m => m.id === parseInt(req.params.id));
  if (msg) { msg.statut = 'traite'; msg.assignedTo = req.body.assignedTo || ''; res.json({ success: true }); }
  else res.json({ success: false, error: 'Message non trouvé' });
});

app.post('/api/messages/:id/assign', (req, res) => {
  const msg = messages.find(m => m.id === parseInt(req.params.id));
  if (msg) { msg.assignedTo = req.body.assignedTo; res.json({ success: true }); }
  else res.json({ success: false, error: 'Message non trouvé' });
});

app.get('/', (req, res) => {
  res.json({ status: 'MAAU Academy Webhook actif', messages: messages.length, timestamp: new Date() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur MAAU Academy démarré sur le port ${PORT}`));
