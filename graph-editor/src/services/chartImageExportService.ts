/**
 * chartImageExportService — download a rendered ECharts chart as an image.
 *
 * Charts in this app use the ECharts SVG renderer (AnalysisChartContainer sets
 * `renderer: 'svg'`), so:
 *  - SVG export is native and lossless via `renderToSVGString()`.
 *  - PNG export rasterises that same SVG onto a canvas — the SVG renderer
 *    cannot emit a raster directly through `getDataURL({type:'png'})`.
 *
 * The chart's title/metadata banner is plain DOM rendered around the chart, not
 * part of the ECharts SVG, so an exported image would otherwise be unlabelled.
 * When a `header` is supplied we compose a title band above the chart in SVG —
 * once — so it appears identically in both the SVG and the (rasterised) PNG.
 *
 * The functions take a structural `ChartImageSource` (the subset of the ECharts
 * instance API they use) rather than the full ECharts type, which keeps the
 * service decoupled from echarts and trivially stubbable in tests.
 */

import { downloadTextFile, downloadDataUrl } from './downloadService';

/** The slice of the ECharts instance API this service relies on. */
export interface ChartImageSource {
  renderToSVGString(opts?: { useViewBox?: boolean }): string;
  getWidth(): number;
  getHeight(): number;
}

/** Titular content baked into the top of an exported chart image. */
export interface ChartExportHeader {
  /** Bold title — e.g. the analysis/chart name. */
  title?: string;
  /** Muted text on the title row, after the title — e.g. the date "1-Jun-26". */
  subtitle?: string;
  /** Muted rows below the title — typically one "name · effective_dsl" per layer. */
  lines?: string[];
}

const HEADER_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const TITLE_SIZE = 15;
const META_SIZE = 11.5;
const PAD_X = 12;
const PAD_TOP = 10;
const PAD_BOTTOM = 8;
const LINE_GAP = 6;
const META_GAP = 4;

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Crude single-line truncation so long titles/DSLs don't overflow the image. */
function truncateToWidth(text: string, maxWidth: number, fontPx: number): string {
  const maxChars = Math.max(4, Math.floor(maxWidth / (fontPx * 0.55)));
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1).trimEnd() + '…';
}

/** Position the chart's own <svg> as a nested viewport at (0, y). */
function nestChartSvg(inner: string, y: number): string {
  const idx = inner.indexOf('<svg');
  const body = idx >= 0 ? inner.slice(idx) : inner;
  // Nested <svg> keeps the chart's coordinate system and ids self-contained.
  return body.replace('<svg', `<svg x="0" y="${y}"`);
}

interface ComposedSvg { svg: string; width: number; height: number; }

/**
 * Build the SVG to export: the chart alone, or the chart with a title band on
 * top when a non-empty header is supplied.
 */
export function composeChartSvg(instance: ChartImageSource, header?: ChartExportHeader): ComposedSvg {
  const width = Math.max(1, Math.round(instance.getWidth()));
  const chartHeight = Math.max(1, Math.round(instance.getHeight()));
  const inner = instance.renderToSVGString();

  const title = header?.title?.trim();
  const subtitle = header?.subtitle?.trim();
  const lines = (header?.lines ?? []).map((l) => l.trim()).filter(Boolean);
  if (!title && !subtitle && lines.length === 0) {
    return { svg: inner, width, height: chartHeight };
  }

  const textMaxW = width - PAD_X * 2;
  const textEls: string[] = [];
  let y = PAD_TOP;

  if (title || subtitle) {
    y += TITLE_SIZE;
    let spans = '';
    if (title) {
      spans += `<tspan font-weight="700" fill="#111827">${xmlEscape(truncateToWidth(title, textMaxW, TITLE_SIZE))}</tspan>`;
    }
    if (subtitle) {
      spans += `<tspan dx="${title ? 8 : 0}" font-size="${META_SIZE}" fill="#6b7280">${xmlEscape(subtitle)}</tspan>`;
    }
    textEls.push(`<text x="${PAD_X}" y="${y}" font-family="${HEADER_FONT}" font-size="${TITLE_SIZE}">${spans}</text>`);
    y += LINE_GAP;
  }

  for (const line of lines) {
    y += META_SIZE;
    textEls.push(
      `<text x="${PAD_X}" y="${y}" font-family="${HEADER_FONT}" font-size="${META_SIZE}" ` +
      `fill="#6b7280">${xmlEscape(truncateToWidth(line, textMaxW, META_SIZE))}</text>`,
    );
    y += META_GAP;
  }

  const bandH = y + PAD_BOTTOM;
  const total = chartHeight + bandH;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${total}" viewBox="0 0 ${width} ${total}">`);
  parts.push(`<rect x="0" y="0" width="${width}" height="${total}" fill="#ffffff"/>`);
  parts.push(...textEls);
  // Hairline separating the title band from the chart.
  parts.push(`<line x1="0" y1="${bandH - 0.5}" x2="${width}" y2="${bandH - 0.5}" stroke="#e5e7eb" stroke-width="1"/>`);
  parts.push(nestChartSvg(inner, bandH));
  parts.push('</svg>');

  return { svg: parts.join(''), width, height: total };
}

/** Download the chart as a native, lossless SVG file (with title band if given). */
export function downloadChartSvg(instance: ChartImageSource, baseFilename: string, header?: ChartExportHeader): void {
  const { svg } = composeChartSvg(instance, header);
  downloadTextFile({ filename: `${baseFilename}.svg`, content: svg, mimeType: 'image/svg+xml' });
}

/**
 * Rasterise the composed chart SVG into a PNG data URL at `pixelRatio` on a
 * solid `background`. Separated from the download step so the conversion can be
 * unit-tested in isolation.
 */
export function chartToPngDataUrl(
  instance: ChartImageSource,
  pixelRatio: number,
  background: string,
  header?: ChartExportHeader,
): Promise<string> {
  const { svg, width, height } = composeChartSvg(instance, header);
  const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

  return new Promise<string>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * pixelRatio));
        canvas.height = Math.max(1, Math.round(height * pixelRatio));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('2D canvas context unavailable for PNG export'));
          return;
        }
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    img.onerror = () => reject(new Error('Failed to rasterise chart SVG for PNG export'));
    img.src = svgUrl;
  });
}

/** Download the chart as a PNG (white background, 2× by default). */
export async function downloadChartPng(
  instance: ChartImageSource,
  baseFilename: string,
  opts: { pixelRatio?: number; background?: string } = {},
  header?: ChartExportHeader,
): Promise<void> {
  const dataUrl = await chartToPngDataUrl(instance, opts.pixelRatio ?? 2, opts.background ?? '#fff', header);
  downloadDataUrl({ filename: `${baseFilename}.png`, dataUrl });
}

/**
 * Dispatch a chart image download by format. The single entry point used by
 * every download surface so PNG error handling lives in one place.
 */
export function downloadChartImage(
  instance: ChartImageSource,
  baseFilename: string,
  format: 'png' | 'svg',
  header?: ChartExportHeader,
): void {
  if (format === 'svg') {
    downloadChartSvg(instance, baseFilename, header);
  } else {
    downloadChartPng(instance, baseFilename, {}, header).catch((err) => {
      console.error('[chartImageExport] PNG export failed', err);
    });
  }
}
