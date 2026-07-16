import { GoogleAuth } from 'google-auth-library';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

/**
 * Resolves Google Cloud credentials and returns an OAuth 2.0 access token along with the GCP project ID.
 */
export async function getAccessToken(): Promise<{ token: string; projectId: string }> {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID || '';
  if (!projectId) {
    throw new Error('GOOGLE_CLOUD_PROJECT_ID is not configured in the environment.');
  }

  // Support GOOGLE_APPLICATION_CREDENTIALS_JSON by writing it to a temporary file
  let credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

  let tempFilePath: string | null = null;
  if (credsJson && !credentialsPath) {
    try {
      // Validate it's actual JSON
      JSON.parse(credsJson.trim());
      const tempDir = path.join(process.cwd(), 'tmp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      tempFilePath = path.join(tempDir, `gcp-creds-${crypto.randomBytes(6).toString('hex')}.json`);
      fs.writeFileSync(tempFilePath, credsJson.trim(), 'utf8');
      credentialsPath = tempFilePath;
      process.env.GOOGLE_APPLICATION_CREDENTIALS = tempFilePath;
    } catch (e) {
      console.error('[IMAGEN] Failed to parse GOOGLE_APPLICATION_CREDENTIALS_JSON:', e);
    }
  }

  try {
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const accessToken = tokenResponse.token;
    if (!accessToken) {
      throw new Error('Successfully authenticated but retrieved an empty access token.');
    }
    return { token: accessToken, projectId };
  } finally {
    // Clean up temporary credentials file if created
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (e) {
        console.error('[IMAGEN] Error deleting temp credential file:', e);
      }
      // Restore previous environment state
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    }
  }
}

/**
 * Calls Vertex AI's Imagen 3 model to generate a campaign asset image, returning a hosted URL or a base64 data URI.
 */
export async function generateImagenAsset(
  prompt: string,
  aspectRatio: string = '1:1',
  imageSize: string = '1K'
): Promise<string> {
  const startTime = Date.now();
  try {
    const { token, projectId } = await getAccessToken();
    const region = process.env.VERTEX_AI_REGION || 'us-central1';
    const modelId = process.env.VERTEX_AI_MODEL_ID || 'gemini-2.5-flash-image';
    const isGemini = modelId.toLowerCase().includes('gemini');
    
    let finalPrompt = prompt;
    if (imageSize === '0.5K') {
      finalPrompt = `${prompt} (optimized mobile preview, lightweight low-bandwidth compression)`;
    }

    let url: string;
    let payload: any;

    if (isGemini) {
      url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${modelId}:generateContent`;
      payload = {
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: finalPrompt,
              },
            ],
          },
        ],
        generation_config: {
          response_modalities: ['IMAGE'],
          image_config: {
            aspect_ratio: aspectRatio,
          },
        },
      };
    } else {
      url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${modelId}:predict`;
      payload = {
        instances: [
          {
            prompt: finalPrompt,
          },
        ],
        parameters: {
          sampleCount: 1,
          aspectRatio: aspectRatio,
          outputMimeType: 'image/jpeg',
          imageSize: imageSize,
        },
      };
    }

    console.log(`[IMAGEN] Sending prediction request to: ${url}`);
    console.log(`[IMAGEN] Prompt: "${finalPrompt}" (Size: ${imageSize}, Ratio: ${aspectRatio})`);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[IMAGEN] Vertex AI responded in ${elapsed}s with status ${response.status} (${response.statusText})`);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Vertex AI prediction API returned HTTP ${response.status}: ${errorBody}`);
    }

    const result = (await response.json()) as any;
    let base64Bytes: string | null = null;

    if (isGemini) {
      if (result.candidates && result.candidates[0] && result.candidates[0].content && result.candidates[0].content.parts) {
        for (const part of result.candidates[0].content.parts) {
          if (part.inlineData && part.inlineData.data) {
            base64Bytes = part.inlineData.data;
            break;
          }
        }
      }
    } else {
      if (result.predictions && result.predictions[0] && result.predictions[0].bytesBase64Encoded) {
        base64Bytes = result.predictions[0].bytesBase64Encoded;
      }
    }

    if (!base64Bytes) {
      throw new Error(`Vertex AI response did not contain image bytes. Response: ${JSON.stringify(result)}`);
    }
    
    const imageName = `campaign-${crypto.randomBytes(8).toString('hex')}.jpg`;
    const imagesDir = path.join(process.cwd(), 'public', 'images');
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }
    const filePath = path.join(imagesDir, imageName);
    fs.writeFileSync(filePath, Buffer.from(base64Bytes, 'base64'));
    
    const baseUrl = process.env.MCP_PUBLIC_URL || 'http://localhost:8090';
    const imageUrl = `${baseUrl.replace(/\/$/, '')}/images/${imageName}`;
    console.log(`[IMAGEN] Image generated and saved locally in ${elapsed}s: ${imageUrl}`);
    return imageUrl;
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error(`[IMAGEN] Exception during prediction after ${elapsed}s:`, err);
    throw err;
  }
}
