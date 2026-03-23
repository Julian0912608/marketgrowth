// ============================================================
// src/modules/ai-engine/services/nano-banana.service.ts
//
// Nano Banana (Gemini Image) integratie voor MarketGrow
// Genereert advertentiebeelden op basis van productdata + verkoopstats
//
// Setup:
//   Railway env var: GEMINI_API_KEY=...
//   Haal op via: aistudio.google.com → Get API Key
//
// Model: gemini-2.0-flash-exp (image generation)
// Prijs: ~$0.013/afbeelding via Google AI Studio
// ============================================================

import { logger } from '../../../shared/logging/logger';

const GEMINI_API_KEY = () => process.env.GEMINI_API_KEY ?? '';

// ── Types ─────────────────────────────────────────────────────

export interface ProductContext {
  title:        string;
  description?: string;
  price?:       number;
  platform:     string;
  revenue30d?:  number;
  sold30d?:     number;
  roas?:        number;
  imageUrl?:    string; // bestaande productfoto als referentie
}

export interface AdCreativeRequest {
  product:    ProductContext;
  format:     'single' | 'carousel' | 'story' | 'banner';
  platform:   'instagram' | 'tiktok' | 'google' | 'meta';
  style?:     'minimal' | 'bold' | 'lifestyle' | 'product-focus';
  brandColor?: string;
}

export interface GeneratedCreative {
  imageUrl:    string;  // base64 data URL
  prompt:      string;  // de gegenereerde prompt (transparantie)
  format:      string;
  aspectRatio: string;
}

// ── Prompt builder ────────────────────────────────────────────

function buildPrompt(req: AdCreativeRequest): string {
  const { product, format, platform, style = 'minimal', brandColor = '#4f46e5' } = req;

  // Aspect ratios per format/platform
  const aspectMap: Record<string, string> = {
    'instagram-single':   '1:1 square (1080x1080px)',
    'instagram-story':    '9:16 vertical (1080x1920px)',
    'instagram-carousel': '1:1 square (1080x1080px)',
    'tiktok-single':      '9:16 vertical (1080x1920px)',
    'google-banner':      '16:9 horizontal (1200x628px)',
    'meta-single':        '1:1 square (1080x1080px)',
    'meta-story':         '9:16 vertical (1080x1920px)',
  };

  const aspectKey   = `${platform}-${format}`;
  const aspectRatio = aspectMap[aspectKey] ?? '1:1 square (1080x1080px)';

  // Performance context voor prompt
  const perfContext = [];
  if (product.revenue30d && product.revenue30d > 0) {
    perfContext.push(`best-seller with €${product.revenue30d.toFixed(0)} revenue last 30 days`);
  }
  if (product.roas && product.roas > 0) {
    perfContext.push(`${product.roas.toFixed(1)}x ROAS`);
  }
  if (product.sold30d && product.sold30d > 0) {
    perfContext.push(`${product.sold30d} units sold recently`);
  }

  const perfText = perfContext.length > 0
    ? `This is a high-performing product: ${perfContext.join(', ')}.`
    : '';

  // Stijl instructies
  const styleGuide: Record<string, string> = {
    'minimal':        'Clean minimalist design, white or light background, plenty of negative space, sophisticated typography, subtle shadows',
    'bold':           'High contrast, bold typography, vibrant colors, strong visual hierarchy, energetic composition',
    'lifestyle':      'Product in natural lifestyle setting, warm lighting, authentic feel, aspirational but relatable',
    'product-focus':  'Studio-quality product photography, clean background, dramatic lighting, premium feel, e-commerce ready',
  };

  const platformGuide: Record<string, string> = {
    'instagram': 'Instagram-optimised ad creative, visually striking, thumb-stopping design',
    'tiktok':    'TikTok-style dynamic visual, bold text overlay, energetic composition',
    'google':    'Google Display ad, clear headline space on left, product prominent on right',
    'meta':      'Facebook/Meta ad creative, clear value proposition, strong visual hook',
  };

  const prompt = `Create a professional ${platform} advertising creative for an ecommerce product.

PRODUCT: ${product.title}
${product.description ? `DESCRIPTION: ${product.description}` : ''}
${product.price ? `PRICE: €${product.price.toFixed(2)}` : ''}
PLATFORM: ${product.platform}
${perfText}

FORMAT: ${format} — ${aspectRatio}
STYLE: ${styleGuide[style]}
PLATFORM REQUIREMENTS: ${platformGuide[platform]}

DESIGN REQUIREMENTS:
- Brand color: ${brandColor} (use as accent color)
- Professional e-commerce advertising quality
- Clear product focus
- Space for text overlay (leave clean area for headline)
- No people unless lifestyle style is requested
- No brand logos except the product itself
- Photorealistic, studio-quality output
- Ready to publish as a paid advertisement

${format === 'carousel' ? 'This is slide 1 of a carousel — make it a strong opener that makes viewers swipe.' : ''}
${format === 'story' ? 'Vertical format optimised for mobile stories — bold visual impact from top to bottom.' : ''}`;

  return prompt;
}

// ── Nano Banana API call ──────────────────────────────────────

export async function generateAdCreative(req: AdCreativeRequest): Promise<GeneratedCreative> {
  const apiKey = GEMINI_API_KEY();
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const prompt = buildPrompt(req);

  logger.info('nano-banana.generate.start', {
    product:  req.product.title,
    platform: req.platform,
    format:   req.format,
  });

  // Gemini imagen via multimodal API
  const body: any = {
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
    },
  };

  // Als er een referentieafbeelding is, stuur die mee
  if (req.product.imageUrl) {
    try {
      const imgRes  = await fetch(req.product.imageUrl);
      if (imgRes.ok) {
        const imgBuf  = await imgRes.arrayBuffer();
        const base64  = Buffer.from(imgBuf).toString('base64');
        const mime    = imgRes.headers.get('content-type') || 'image/jpeg';
        body.contents[0].parts.unshift({
          inlineData: { mimeType: mime, data: base64 }
        });
      }
    } catch {
      // Referentieafbeelding ophalen mislukt — genereer zonder
    }
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Nano Banana API error (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json() as {
    candidates?: {
      content?: {
        parts?: { inlineData?: { mimeType: string; data: string }; text?: string }[]
      }
    }[]
  };

  const parts     = data.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find(p => p.inlineData?.data);

  if (!imagePart?.inlineData) {
    throw new Error('Nano Banana returned no image. The model may have declined the prompt.');
  }

  const { mimeType, data: imageData } = imagePart.inlineData;
  const dataUrl = `data:${mimeType};base64,${imageData}`;

  // Aspect ratio bepalen
  const aspectMap: Record<string, string> = {
    'instagram-single':   '1:1',
    'instagram-story':    '9:16',
    'instagram-carousel': '1:1',
    'tiktok-single':      '9:16',
    'google-banner':      '16:9',
    'meta-single':        '1:1',
  };

  logger.info('nano-banana.generate.complete', {
    product:  req.product.title,
    platform: req.platform,
    format:   req.format,
    bytes:    imageData.length,
  });

  return {
    imageUrl:    dataUrl,
    prompt,
    format:      req.format,
    aspectRatio: aspectMap[`${req.platform}-${req.format}`] ?? '1:1',
  };
}

// ── Batch generatie voor carousel ─────────────────────────────

export async function generateCarouselSlides(
  req: AdCreativeRequest,
  slideCount: number = 3,
): Promise<GeneratedCreative[]> {
  const slides: GeneratedCreative[] = [];

  for (let i = 0; i < slideCount; i++) {
    const slideReq = {
      ...req,
      format: 'carousel' as const,
    };
    // Voeg slide nummer toe aan prompt context
    (slideReq as any)._slideIndex = i + 1;
    (slideReq as any)._totalSlides = slideCount;

    const slide = await generateAdCreative(slideReq);
    slides.push(slide);

    // Kleine pauze tussen calls
    if (i < slideCount - 1) await new Promise(r => setTimeout(r, 500));
  }

  return slides;
}
