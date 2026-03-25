const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const tmp = require('tmp');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY not set');
  process.exit(1);
}

const client = new Anthropic({ apiKey: API_KEY });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const upload = multer({
  dest: tmp.dirSync().name,
  limits: { fileSize: 200 * 1024 * 1024 },
});

async function extractFrames(videoPath) {
  return new Promise((resolve, reject) => {
    const tmpDir = tmp.dirSync().name;
    let duration = 0;
    let frames = [];

    ffmpeg(videoPath)
      .on('metadata', (meta) => {
        duration = parseFloat(meta.duration);
      })
      .screenshots({
        count: 10,
        folder: tmpDir,
        filename: 'frame-%i.png',
        size: '640x?',
      })
      .on('filenames', (filenames) => {
        try {
          filenames.forEach((filename) => {
            const filePath = path.join(tmpDir, filename);
            const imageBuffer = fs.readFileSync(filePath);
            frames.push({
              base64: imageBuffer.toString('base64'),
              mediaType: 'image/png',
            });
            fs.unlinkSync(filePath);
          });
          resolve({ frames, duration });
        } catch (err) {
          reject(err);
        }
      })
      .on('error', reject);
  });
}

async function analyzeFrames(frames, athlete, sessionType, load, focusAreas, coachNotes) {
  const systemPrompt = `You are an elite biomechanics analyst specializing in para powerlifting. Analyze the video frames for bar path, velocity, setup stability, and form quality.

Provide a JSON response with these fields:
- overall_score, technique_score, setup_score, consistency_score (all 0-100)
- verdict ("Green" / "Amber" / "Attention")
- summary (brief assessment)
- bar_speed_estimate (estimated m/s concentric velocity)
- setup_and_position object with strengths/improvements
- bar_path_and_control object with strengths/concerns
- power_output assessment
- para_specific_factors
- rep_quality_profile (array of scores for each rep)
- immediate_coaching_cues (array of 3)
- next_session_recommendations (array of 3-4)`;

  const userPrompt = `Athlete: ${athlete}
Session: ${sessionType} @ ${load}
Focus: ${focusAreas.join(', ') || 'General'}
Notes: ${coachNotes || 'None'}

Analyze these frames chronologically from start position through lockout. Estimate bar speed from frame position changes across time.`;

  const messageContent = [{ type: 'text', text: userPrompt }];

  frames.forEach((frame) => {
    messageContent.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: frame.mediaType,
        data: frame.base64,
      },
    });
  });

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: messageContent }],
  });

  const responseText = response.content[0].text;
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);

  if (!jsonMatch) throw new Error('Could not parse Claude response');

  return JSON.parse(jsonMatch[0]);
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/analyze', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No video' });

    const { athlete, sessionType, load, focusAreas, coachNotes } = req.body;
    const parsedAreas = typeof focusAreas === 'string'
      ? focusAreas.split(',').map((a) => a.trim())
      : focusAreas;

    console.log(`Analyzing video for ${athlete}...`);

    const { frames, duration } = await extractFrames(req.file.path);
    fs.unlinkSync(req.file.path);

    if (frames.length === 0) {
      return res.status(400).json({ error: 'Could not extract frames' });
    }

    console.log(`Extracted ${frames.length} frames from ${duration}s video`);

    const analysis = await analyzeFrames(frames, athlete, sessionType, load, parsedAreas, coachNotes);

    res.json({
      success: true,
      data: analysis,
      metadata: {
        framesAnalyzed: frames.length,
        videoDuration: duration,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🏋️ Para Lift Analyser running on port ${PORT}`);
});