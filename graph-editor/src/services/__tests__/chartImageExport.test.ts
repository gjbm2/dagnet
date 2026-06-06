import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  downloadChartSvg,
  downloadChartPng,
  downloadChartImage,
  composeChartSvg,
  type ChartImageSource,
} from '../chartImageExportService';
import { downloadTextFile, downloadDataUrl } from '../downloadService';
import { analysisResultBaseFilename } from '../analysisExportService';
import {
  registerChartImageProvider,
  unregisterChartImageProvider,
  getChartImageInstance,
} from '../chartImageExportRegistry';
import { buildScenarioQueryLines } from '../../lib/chartQueryLabel';

vi.mock('../downloadService', () => ({
  downloadTextFile: vi.fn(),
  downloadDataUrl: vi.fn(),
}));

function makeInstance(overrides: Partial<ChartImageSource> = {}): ChartImageSource {
  return {
    renderToSVGString: vi.fn(() => '<svg width="400" height="300"><rect id="chart"/></svg>'),
    getWidth: vi.fn(() => 400),
    getHeight: vi.fn(() => 300),
    ...overrides,
  };
}

describe('analysisResultBaseFilename', () => {
  it('sanitises the analysis name to a kebab-case base (no extension)', () => {
    expect(analysisResultBaseFilename({ analysis_name: 'My Chart!! (v2)' } as any)).toBe('my-chart-v2');
  });
  it('falls back to analysis_type, preserving underscores', () => {
    expect(analysisResultBaseFilename({ analysis_type: 'cohort_maturity' } as any)).toBe('cohort_maturity');
  });
  it('falls back to "analysis" when nothing is named', () => {
    expect(analysisResultBaseFilename({} as any)).toBe('analysis');
  });
});

describe('downloadChartSvg', () => {
  beforeEach(() => vi.clearAllMocks());

  it('downloads the chart SVG verbatim when no header is supplied', () => {
    const inst = makeInstance();
    downloadChartSvg(inst, 'my-chart');
    expect(downloadTextFile).toHaveBeenCalledWith({
      filename: 'my-chart.svg',
      content: '<svg width="400" height="300"><rect id="chart"/></svg>',
      mimeType: 'image/svg+xml',
    });
  });

  it('bakes a title band (title + subtitle + per-layer lines) above the chart', () => {
    const inst = makeInstance();
    downloadChartSvg(inst, 'my-chart', {
      title: 'Cohort Maturity',
      subtitle: '1-Jun-26',
      lines: ['Current · window(1-May:31-May).from(a).to(b)', 'Mobile · cohort(a).window(1-May:31-May)'],
    });
    const arg = (downloadTextFile as any).mock.calls[0][0];
    expect(arg.filename).toBe('my-chart.svg');
    expect(arg.content).toContain('Cohort Maturity');
    expect(arg.content).toContain('1-Jun-26');
    expect(arg.content).toContain('window(1-May:31-May).from(a).to(b)');
    expect(arg.content).toContain('cohort(a).window(1-May:31-May)');
    // Original chart content is nested below the band.
    expect(arg.content).toContain('<rect id="chart"/>');
  });
});

describe('composeChartSvg', () => {
  it('returns the chart unchanged with no header', () => {
    const inst = makeInstance();
    const { svg, width, height } = composeChartSvg(inst);
    expect(svg).toBe('<svg width="400" height="300"><rect id="chart"/></svg>');
    expect(width).toBe(400);
    expect(height).toBe(300);
  });

  it('grows the height by the title band and nests the chart at an offset', () => {
    const inst = makeInstance();
    const { svg, width, height } = composeChartSvg(inst, { title: 'T', lines: ['L1', 'L2'] });
    expect(width).toBe(400);
    expect(height).toBeGreaterThan(300); // band added on top of the 300px chart
    expect(svg).toContain('<svg x="0" y=');
  });

  it('XML-escapes header text', () => {
    const inst = makeInstance();
    const { svg } = composeChartSvg(inst, { title: 'A & B <x>' });
    expect(svg).toContain('A &amp; B &lt;x&gt;');
  });
});

describe('downloadChartPng (rasterised from SVG)', () => {
  let originalImage: typeof Image;
  let createElementSpy: ReturnType<typeof vi.spyOn>;
  let drawn: { fillRect: any; drawImage: any };

  beforeEach(() => {
    vi.clearAllMocks();
    originalImage = global.Image;
    class MockImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      width = 400;
      height = 300;
      set src(_v: string) {
        // Simulate async decode completing successfully.
        queueMicrotask(() => this.onload && this.onload());
      }
    }
    // @ts-expect-error test shim
    global.Image = MockImage;

    drawn = { fillRect: vi.fn(), drawImage: vi.fn() };
    const realCreate = document.createElement.bind(document);
    createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ({ fillStyle: '', fillRect: drawn.fillRect, drawImage: drawn.drawImage }),
          toDataURL: () => 'data:image/png;base64,FAKE',
        } as any;
      }
      return realCreate(tag);
    });
  });

  afterEach(() => {
    global.Image = originalImage;
    createElementSpy.mockRestore();
  });

  it('sizes the canvas at width×height×pixelRatio and downloads a PNG data URL', async () => {
    const inst = makeInstance();
    await downloadChartPng(inst, 'my-chart', { pixelRatio: 2 });
    expect(drawn.fillRect).toHaveBeenCalled();
    expect(drawn.drawImage).toHaveBeenCalled();
    expect(downloadDataUrl).toHaveBeenCalledWith({
      filename: 'my-chart.png',
      dataUrl: 'data:image/png;base64,FAKE',
    });
  });

  it('downloadChartImage dispatches by format', async () => {
    const inst = makeInstance();
    downloadChartImage(inst, 'c', 'svg');
    expect(downloadTextFile).toHaveBeenCalledTimes(1);

    downloadChartImage(inst, 'c', 'png');
    // PNG path is async fire-and-forget; let the microtask + promise settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(downloadDataUrl).toHaveBeenCalledTimes(1);
  });
});

describe('buildScenarioQueryLines', () => {
  it('combines each layer scope with the shared path (scope leads, path retained)', () => {
    const lines = buildScenarioQueryLines({
      visibleScenarioIds: ['current', 'mobile'],
      scenarioNameById: { current: { name: 'Current' }, mobile: { name: 'Mobile' } },
      scopeDslById: {
        current: 'window(1-May:31-May)',
        mobile: 'cohort(signup,1-May:31-May).context(device:mobile)',
      },
      pathDsl: 'from(household-created).to(switch-success)',
    });
    expect(lines).toEqual([
      'Current · window(1-May:31-May).from(household-created).to(switch-success)',
      'Mobile · cohort(signup,1-May:31-May).context(device:mobile).from(household-created).to(switch-success)',
    ]);
  });

  it('shows just the path when a layer has no scope DSL', () => {
    const lines = buildScenarioQueryLines({
      visibleScenarioIds: ['current'],
      scenarioNameById: { current: { name: 'Current' } },
      scopeDslById: {},
      pathDsl: 'from(a).to(b)',
    });
    expect(lines).toEqual(['Current · from(a).to(b)']);
  });

  it('strips a blank asat() clause (and its dangling dot) wherever it sits', () => {
    expect(
      buildScenarioQueryLines({
        visibleScenarioIds: ['s1', 's2'],
        scopeDslById: { s1: 'window(1-May:31-May).asat()', s2: 'asat().cohort(a,1-May:31-May)' },
        pathDsl: 'from(a).to(b)',
      }),
    ).toEqual([
      's1 · window(1-May:31-May).from(a).to(b)',
      's2 · cohort(a,1-May:31-May).from(a).to(b)',
    ]);
  });

  it('keeps a non-blank asat()', () => {
    expect(
      buildScenarioQueryLines({
        visibleScenarioIds: ['s1'],
        scopeDslById: { s1: 'window(1-May:31-May).asat(1-Jun-26)' },
        pathDsl: 'from(a).to(b)',
      }),
    ).toEqual(['s1 · window(1-May:31-May).asat(1-Jun-26).from(a).to(b)']);
  });

  it('does not duplicate the path if a scope DSL already carries from(', () => {
    const lines = buildScenarioQueryLines({
      visibleScenarioIds: ['s1'],
      scopeDslById: { s1: 'window(:).from(a).to(b)' },
      pathDsl: 'from(a).to(b)',
    });
    expect(lines).toEqual(['s1 · window(:).from(a).to(b)']);
  });

  it('returns a single path line when there are no visible layers', () => {
    expect(buildScenarioQueryLines({ visibleScenarioIds: [], pathDsl: 'from(a).to(b)' })).toEqual(['from(a).to(b)']);
  });

  it('returns an empty array when there is nothing to describe', () => {
    expect(buildScenarioQueryLines({ visibleScenarioIds: [] })).toEqual([]);
  });
});

describe('chartImageExportRegistry', () => {
  it('registers, resolves, and unregisters a provider', () => {
    const inst = makeInstance();
    const getter = () => inst;
    registerChartImageProvider('k1', getter);
    expect(getChartImageInstance('k1')).toBe(inst);
    unregisterChartImageProvider('k1', getter);
    expect(getChartImageInstance('k1')).toBeNull();
  });

  it('unregister only removes the matching getter (no clobbering a re-register)', () => {
    const inst = makeInstance();
    const g1 = () => inst;
    const g2 = () => null;
    registerChartImageProvider('k2', g1);
    unregisterChartImageProvider('k2', g2); // stale cleanup from a previous getter — must be a no-op
    expect(getChartImageInstance('k2')).toBe(inst);
    unregisterChartImageProvider('k2', g1);
    expect(getChartImageInstance('k2')).toBeNull();
  });

  it('returns null for an unknown key', () => {
    expect(getChartImageInstance('never-registered')).toBeNull();
  });
});
