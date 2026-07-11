import express from 'express';
import { config } from './config.js';
import voiceRouter from './routes/voice.js';
import audioRouter from './routes/audio.js';
import dashboardRouter from './routes/dashboard.js';

// Defense in depth: every voice route is already wrapped (see safeVoiceHandler in routes/voice.js),
// but this stops an unrelated unhandled rejection from taking down the whole server mid-demo.
process.on('unhandledRejection', (reason) => {
  console.error('[index] Unhandled promise rejection:', reason);
});

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio webhooks (form-encoded)
app.use(express.json());

app.use(voiceRouter);
app.use(audioRouter);
app.use(dashboardRouter);

app.listen(config.port, () => {
  console.log(`Arya intake agent server listening on port ${config.port}`);
  if (!config.publicBaseUrl) {
    console.warn('[index] PUBLIC_BASE_URL is not set — set it to your ngrok URL once the tunnel is up.');
  }
});
