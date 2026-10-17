// Chart.js setup shared by all dashboard graphs: dark grid, neon lines with a
// restrained glow, monotone smoothing (never overshoots the real values),
// exact values in tooltips.

const charts = {};

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    || getComputedStyle(document.body).getPropertyValue(name).trim();
}

/** Resolve a CSS colour (including var()/color-mix) to rgb() via the browser. */
function resolveColor(value) {
  const probe = document.createElement('span');
  probe.style.color = value;
  probe.style.display = 'none';
  document.body.append(probe);
  const out = getComputedStyle(probe).color;
  probe.remove();
  return out;
}

function alpha(rgb, a) {
  const m = rgb.match(/[\d.]+/g);
  if (!m) return rgb;
  return `rgba(${m[0]}, ${m[1]}, ${m[2]}, ${a})`;
}

const glowPlugin = {
  id: 'neonGlow',
  beforeDatasetDraw(chart, args) {
    const ds = chart.data.datasets[args.index];
    const glow = Number(css('--glow')) || 0;
    if (!ds.glow || glow <= 0) return;
    const { ctx } = chart;
    ctx.save();
    ctx.shadowColor = ds.borderColor;
    ctx.shadowBlur = 10 * glow;
  },
  afterDatasetDraw(chart, args) {
    const ds = chart.data.datasets[args.index];
    const glow = Number(css('--glow')) || 0;
    if (!ds.glow || glow <= 0) return;
    chart.ctx.restore();
  },
};

function gradient(chart, color) {
  const { ctx, chartArea } = chart;
  if (!chartArea) return alpha(color, 0.1);
  const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  g.addColorStop(0, alpha(color, 0.22));
  g.addColorStop(1, alpha(color, 0));
  return g;
}

function baseOptions({ yTitle, yFormat, tooltipFormat, integer = false }) {
  const text3 = resolveColor('var(--text-3)');
  const text2 = resolveColor('var(--text-2)');
  const grid = 'rgba(150, 200, 255, 0.07)';
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: document.documentElement.classList.contains('reduce-motion')
      || matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 450 },
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 6, right: 6 } },
    elements: {
      line: { tension: 0.35, cubicInterpolationMode: 'monotone', borderWidth: 2 },
      point: { radius: 2.5, hoverRadius: 5, hitRadius: 12, borderWidth: 0, hoverBorderWidth: 2 },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { color: grid },
        ticks: { color: text3, font: { family: 'Space Grotesk', size: 11 }, maxRotation: 0, autoSkip: true, autoSkipPadding: 12 },
      },
      y: {
        beginAtZero: true,
        grid: { color: grid },
        border: { display: false },
        title: { display: Boolean(yTitle), text: yTitle, color: text3, font: { family: 'Space Grotesk', size: 11 } },
        ticks: {
          color: text3,
          font: { family: 'Space Grotesk', size: 11 },
          precision: integer ? 0 : undefined,
          stepSize: integer ? 1 : undefined,
          maxTicksLimit: 6,
          callback: yFormat,
        },
        suggestedMax: integer ? 4 : undefined,
      },
    },
    plugins: {
      legend: {
        display: false,
        labels: { color: text2, usePointStyle: true, pointStyle: 'circle', boxWidth: 7, boxHeight: 7, font: { family: 'Space Grotesk', size: 12 } },
      },
      tooltip: {
        backgroundColor: 'rgba(10, 13, 22, 0.96)',
        borderColor: 'rgba(150, 220, 255, 0.25)',
        borderWidth: 1,
        titleColor: '#e9eef7',
        bodyColor: '#a3adc2',
        titleFont: { family: 'Space Grotesk', weight: '500' },
        bodyFont: { family: 'Space Grotesk' },
        padding: 10,
        cornerRadius: 10,
        displayColors: true,
        boxWidth: 8,
        boxHeight: 8,
        usePointStyle: true,
        callbacks: { label: tooltipFormat },
      },
    },
  };
}

function dataset(label, data, color, { dashed = false, fill = true } = {}) {
  return {
    label,
    data,
    borderColor: color,
    pointBackgroundColor: color,
    pointBorderColor: '#05060b',
    backgroundColor: fill ? (ctx) => gradient(ctx.chart, color) : color, // unfilled: colour feeds the legend swatch
    fill: fill ? 'origin' : false,
    borderDash: dashed ? [5, 5] : undefined,
    glow: !dashed,
    spanGaps: false,
  };
}

/**
 * Creates or updates a line chart.
 * @param {string} id canvas id
 * @param {{labels:string[], series:{label:string,data:(number|null)[],color:string,dashed?:boolean,fill?:boolean}[], options:object, legend?:boolean}} cfg
 */
export function renderLineChart(id, cfg) {
  const ChartJs = window.Chart;
  if (!ChartJs) return;
  const datasets = cfg.series.map((s) => dataset(s.label, s.data, resolveColor(s.color), s));
  const options = baseOptions(cfg.options);
  options.plugins.legend.display = Boolean(cfg.legend);
  const existing = charts[id];
  if (existing) {
    existing.data.labels = cfg.labels;
    existing.data.datasets = datasets;
    existing.options = options;
    existing.update();
    return existing;
  }
  const canvas = document.getElementById(id);
  charts[id] = new ChartJs(canvas, { type: 'line', data: { labels: cfg.labels, datasets }, options, plugins: [glowPlugin] });
  return charts[id];
}

export function resizeCharts() {
  for (const c of Object.values(charts)) c.resize();
}
