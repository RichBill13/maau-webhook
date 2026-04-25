const express = require('express');
const app = express();
app.use(express.json());

// CORS — autoriser toutes les origines
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
// Token de vérification webhook (à garder secret)
const VERIFY_TOKEN = 'maau_academy_webhook_2024';

// Token d'accès WhatsApp
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '990950227445636';

// Stockage temporaire des messages (en mémoire)
let messages = [];

// Templates de réponse MAAU Academy
const TEMPLATES = {
  MSG07: "Bonjour [Prénom],\n\nNous avons bien pris en compte votre message.\n\nNous revenons vers vous dans les plus brefs délais avec les éléments nécessaires.\n\nMA-AU Academy 🌟",
  MSG21: "Bonjour [Prénom],\n\nMerci pour votre retour.\n\nNous comprenons votre ressenti et restons attentifs à la situation.\n\nNotre objectif est d'assurer un accompagnement de qualité.\n\nMA-AU Academy 🌟",
  MSG06: "Bonjour [Prénom],\n\nSuite à l'absence, nous vous proposons d'organiser une séance de rattrapage.\n\nJe vous invite à nous partager vos disponibilités.\n\nMA-AU Academy 🌟"
};

// ==================
// WEBHOOK VERIFICATION
// ==================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook vérifié avec succès');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ==================
// RECEPTION MESSAGES
// ==================
app.post('/webhook', (req, res) => {
  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    body.entry?.forEach(entry => {
      entry.changes?.forEach(change => {
        const value = change.value;
        
        // Message reçu
        if (value.messages) {
          value.messages.forEach(msg => {
            const from = msg.from;
            const messageId = msg.id;
            const timestamp = new Date(parseInt(msg.timestamp) * 1000);
            
            let content = '';
            let type = 'text';
            
            if (msg.type === 'text') {
              content = msg.text?.body || '';
              type = 'text';
            } else if (msg.type === 'audio') {
              content = '[Note vocale reçue]';
              type = 'audio';
            } else if (msg.type === 'image') {
              content = '[Image reçue]';
              type = 'image';
            } else if (msg.type === 'document') {
              content = '[Document reçu: ' + (msg.document?.filename || 'fichier') + ']';
              type = 'document';
            } else {
              content = '[Message de type: ' + msg.type + ']';
              type = msg.type;
            }

            // Récupérer le nom du contact
            const contact = value.contacts?.find(c => c.wa_id === from);
            const name = contact?.profile?.name || from;

            // Classifier automatiquement
            const categorie = classifyMessage(content);

            const newMessage = {
              id: Date.now(),
              messageId,
              from,
              name,
              content,
              type,
              categorie,
              timestamp,
              statut: 'non-traite',
              assignedTo: '',
              reponse: ''
            };

            messages.push(newMessage);
            console.log('Nouveau message reçu de:', name, '(', from, '):', content);
          });
        }
      });
    });
  }

  res.sendStatus(200);
});

// ==================
// CLASSIFICATION AUTOMATIQUE
// ==================
function classifyMessage(content) {
  const lower = content.toLowerCase();
  
  if (lower.includes('urgent') || lower.includes('problème') || lower.includes('aide') || lower.includes('ne fonctionne pas') || lower.includes('bloqué')) {
    return 'urgent';
  }
  if (lower.includes('paiement') || lower.includes('facture') || lower.includes('payer') || lower.includes('tarif') || lower.includes('prix')) {
    return 'financier';
  }
  if (lower.includes('cours') || lower.includes('séance') || lower.includes('rattrapage') || lower.includes('absent') || lower.includes('horaire')) {
    return 'pedagogique';
  }
  if (lower.includes('connexion') || lower.includes('meet') || lower.includes('lien') || lower.includes('technique') || lower.includes('application')) {
    return 'operationnel';
  }
  if (lower.includes('annul') || lower.includes('règle') || lower.includes('contrat')) {
    return 'cadre';
  }
  if (lower.includes('mécontent') || lower.includes('insatisfait') || lower.includes('plainte') || lower.includes('problème')) {
    return 'relation';
  }
  
  return 'commercial';
}

// ==================
// API POUR LE TABLEAU DE BORD
// ==================

// Récupérer tous les messages
app.get('/api/messages', (req, res) => {
  res.json({ success: true, messages });
});

// Envoyer une réponse WhatsApp
app.post('/api/reply', async (req, res) => {
  const { to, message, messageId } = req.body;
  console.log('Tentative envoi réponse à:', to, 'Message:', message);
  
  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: to,
          type: 'text',
          text: { body: message }
        })
      }
    );

    const data = await response.json();
    console.log('Réponse Meta:', JSON.stringify(data));
    
    const msg = messages.find(m => m.id === messageId);
    if (msg) {
      msg.statut = 'traite';
      msg.reponse = message;
    }

    res.json({ success: true, data });
  } catch (error) {
    console.error('Erreur envoi message:', error);
    res.json({ success: false, error: error.message });
  }
});

// Marquer comme traité
app.post('/api/messages/:id/done', (req, res) => {
  const msg = messages.find(m => m.id === parseInt(req.params.id));
  if (msg) {
    msg.statut = 'traite';
    msg.assignedTo = req.body.assignedTo || '';
    res.json({ success: true });
  } else {
    res.json({ success: false, error: 'Message non trouvé' });
  }
});

// Assigner un message
app.post('/api/messages/:id/assign', (req, res) => {
  const msg = messages.find(m => m.id === parseInt(req.params.id));
  if (msg) {
    msg.assignedTo = req.body.assignedTo;
    res.json({ success: true });
  } else {
    res.json({ success: false, error: 'Message non trouvé' });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'MAAU Academy Webhook actif',
    messages: messages.length,
    timestamp: new Date()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur MAAU Academy démarré sur le port ${PORT}`);
});
