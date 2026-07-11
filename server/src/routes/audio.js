// Serves previously synthesized TTS audio clips so Twilio's <Play> verb can
// fetch them over a public URL (Twilio does not accept inline binary audio).
//
// Mounting is owned by src/index.js (app.use(audioRouter)) — this module only
// exports the router.

import { Router } from 'express';
import { getAudio } from '../lib/audioStore.js';

const router = Router();

router.get('/audio/:id', (req, res) => {
  const { id } = req.params;
  const audio = getAudio(id);

  if (!audio) {
    res.status(404).send('Not found');
    return;
  }

  res.set('Content-Type', audio.mimeType);
  res.set('Content-Length', String(audio.buffer.length));
  res.send(audio.buffer);
});

export default router;
