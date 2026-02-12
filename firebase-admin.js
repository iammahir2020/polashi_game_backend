const admin = require("firebase-admin");
require('dotenv').config();

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID, // You can reuse these env names
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,  // You'll need to add this to .env
      // Fixes the private key formatting from .env
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();

module.exports = { db, admin };