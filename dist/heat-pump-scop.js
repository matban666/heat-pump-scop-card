class HeatPumpSCOPCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._data = null;
    this._loading = true;
  }

  setConfig(config) {
    this.config = {
      ...config,
      days: config.days || 365,
      setpoint: config.setpoint || 21.0,
      title: config.title || 'Heat Pump SCOP Performance',
      width: config.width || 700,
      height: config.height || 400,
      scop_type: config.scop_type || 'ch',
      cop_threshold: config.cop_threshold ?? 1.0,
      energy_in_threshold: config.energy_in_threshold ?? 0.1,
      color_periods: config.color_periods || null,
    };
  }

  set hass(hass) {
    const firstHass = !this._hass;
    this._hass = hass;
    if (this.config && firstHass) {
      this.fetchData();
    }
  }

  async fetchData() {
    this._loading = true;
    this._error = null;
    this.render();

    try {
      const entryId = await this._getEntryId();
      const sid = (type) => `heat_pump_monitor:${type}_${entryId}`;

      const types = ['daily_mean_inside_temp', 'daily_mean_outside_temp'];
      const scopType = this.config.scop_type;
      const parts = scopType === 'ch' || scopType === 'dhw' ? [scopType] : ['ch', 'dhw'];
      parts.forEach((p) => types.push(`daily_${p}_energy_in`, `daily_${p}_energy_out`, `daily_${p}_scop`));

      const end = new Date();
      const start = new Date(end.getTime() - this.config.days * 86400000);
      const stats = await this._hass.callWS({
        type: 'recorder/statistics_during_period',
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        statistic_ids: types.map(sid),
        period: 'day',
        types: ['mean'],
      });

      // Index each series by local calendar date
      const byDate = {};
      types.forEach((t) => {
        (stats[sid(t)] || []).forEach((row) => {
          if (row.mean === null || row.mean === undefined) return;
          const date = this._localDate(row.start);
          (byDate[date] = byDate[date] || {})[t] = row.mean;
        });
      });

      const data = [];
      const passes = (p) =>
        p.temp_delta > 0 &&
        p.scop > this.config.cop_threshold &&
        p.energy_in > this.config.energy_in_threshold;

      Object.keys(byDate).sort().forEach((date) => {
        const d = byDate[date];
        const inside = d.daily_mean_inside_temp;
        const outside = d.daily_mean_outside_temp;
        if (inside === undefined || outside === undefined) return;
        const base = { date, inside_temp: inside, outside_temp: outside, temp_delta: inside - outside };

        if (scopType === 'combined') {
          const energyIn = (d.daily_ch_energy_in || 0) + (d.daily_dhw_energy_in || 0);
          const energyOut = (d.daily_ch_energy_out || 0) + (d.daily_dhw_energy_out || 0);
          const p = {
            ...base,
            scop: energyIn > 0 ? energyOut / energyIn : 0,
            energy_in: energyIn,
            energy_out: energyOut,
            type: 'combined',
          };
          if (passes(p)) data.push(p);
          return;
        }

        parts.forEach((part) => {
          const scop = d[`daily_${part}_scop`];
          if (scop === undefined) return;
          const p = {
            ...base,
            scop,
            energy_in: d[`daily_${part}_energy_in`] || 0,
            energy_out: d[`daily_${part}_energy_out`] || 0,
            type: part,
          };
          if (passes(p)) data.push(p);
        });
      });

      this._data = data;
      this._loading = false;
      this.render();
    } catch (error) {
      console.error('heat-pump-scop-card: failed to fetch statistics:', error);
      this._loading = false;
      this._error = error.message || String(error);
      this.render();
    }
  }

  async _getEntryId() {
    if (this.config.entry_id) return this.config.entry_id;
    if (this._entryId) return this._entryId;
    const entries = await this._hass.callWS({ type: 'config_entries/get', domain: 'heat_pump_monitor' });
    if (!entries || entries.length === 0) {
      throw new Error('Heat Pump Monitor integration is not set up');
    }
    const entry = entries.find((e) => e.state === 'loaded') || entries[0];
    this._entryId = entry.entry_id;
    return this._entryId;
  }

  _localDate(start) {
    const d = new Date(typeof start === 'number' ? start : Date.parse(start));
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  render() {
    if (this._loading) {
      this.shadowRoot.innerHTML = `
        <ha-card>
          <div style="padding: 16px; text-align: center;">
            <div style="margin-bottom: 8px;">Loading statistics...</div>
            <div style="font-size: 12px; color: var(--secondary-text-color);">
              Querying ${this.config.days} days of history
            </div>
          </div>
        </ha-card>
      `;
      return;
    }

    if (this._error) {
      this.shadowRoot.innerHTML = `
        <ha-card>
          ${this.renderControls()}
          <div style="padding: 16px; color: var(--error-color);">
            <strong>Error:</strong> ${this._error}
          </div>
        </ha-card>
      `;
      return;
    }

    if (!this._data || this._data.length === 0) {
      this.shadowRoot.innerHTML = `
        <ha-card>
          ${this.renderControls()}
          <div style="padding: 16px;">
            No statistics available for the last ${this.config.days} days.
          </div>
        </ha-card>
      `;
      return;
    }

    this.renderChart(this._data);
  }

  renderControls() {
    return `
      <div style="padding: 12px 16px; background: var(--secondary-background-color); border-bottom: 1px solid var(--divider-color);">
        <div style="display: flex; gap: 24px; align-items: center; flex-wrap: wrap;">
          <div style="flex: 1; min-width: 200px;">
            <label style="display: block; font-size: 12px; color: var(--secondary-text-color); margin-bottom: 4px;">
              Days of History: <strong>${this.config.days}</strong>
            </label>
            <input
              type="range"
              min="7"
              max="730"
              value="${this.config.days}"
              class="control-slider"
              data-field="days"
              style="width: 100%;"
            />
            <div style="display: flex; justify-content: space-between; font-size: 10px; color: var(--secondary-text-color); margin-top: 2px;">
              <span>7 days</span>
              <span>2 years</span>
            </div>
          </div>
          <div style="min-width: 150px;">
            <label style="display: block; font-size: 12px; color: var(--secondary-text-color); margin-bottom: 4px;">
              SCOP Type
            </label>
            <select class="scop-type-select" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color);">
              <option value="ch" ${this.config.scop_type === 'ch' ? 'selected' : ''}>CH Only</option>
              <option value="combined" ${this.config.scop_type === 'combined' ? 'selected' : ''}>Combined</option>
              <option value="dhw" ${this.config.scop_type === 'dhw' ? 'selected' : ''}>DHW Only</option>
              <option value="both" ${this.config.scop_type === 'both' ? 'selected' : ''}>Both</option>
            </select>
          </div>
          <button class="refresh-button" style="padding: 8px 16px; background: var(--primary-color); color: var(--text-primary-color); border: none; border-radius: 4px; cursor: pointer; font-weight: 500;">
            Refresh
          </button>
        </div>
      </div>
    `;
  }

  setupControlListeners() {
    const sliders = this.shadowRoot.querySelectorAll('.control-slider');
    sliders.forEach(slider => {
      slider.addEventListener('input', (e) => {
        const field = e.target.dataset.field;
        const value = parseInt(e.target.value);
        this.config[field] = value;
        // Update the label
        const label = e.target.previousElementSibling;
        if (field === 'days') {
          label.innerHTML = `Days of History: <strong>${value}</strong>`;
        }
      });
    });

    const scopTypeSelect = this.shadowRoot.querySelector('.scop-type-select');
    if (scopTypeSelect) {
      scopTypeSelect.addEventListener('change', (e) => {
        this.config.scop_type = e.target.value;
        this.fetchData();
      });
    }

    const refreshButton = this.shadowRoot.querySelector('.refresh-button');
    if (refreshButton) {
      refreshButton.addEventListener('click', () => {
        this.fetchData();
      });
    }
  }

  renderChart(data) {
    const title = this.config.title;
    const width = this.config.width;
    const height = this.config.height;
    const padding = { top: 40, right: 40, bottom: 60, left: 60 };

    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    // Calculate data ranges
    const outsideTemps = data.map(d => d.outside_temp);
    const scops = data.map(d => d.scop);

    const minTemp = Math.floor(Math.min(...outsideTemps));
    const maxTemp = Math.ceil(Math.max(...outsideTemps));

    const minScop = Math.floor(Math.min(...scops) * 0.95);
    const maxScop = Math.ceil(Math.max(...scops) * 1.05);

    // Dynamic sizing for responsiveness
    const baseChartDimension = Math.min(chartWidth, chartHeight);
    const baseSvgFontSize = Math.max(10, Math.min(16, baseChartDimension * 0.025)); // Scale font size
    const axisLabelFontSize = Math.max(12, Math.min(18, baseChartDimension * 0.035)); // Slightly larger for axis labels
    const baseCircleRadius = Math.max(2, Math.min(5, baseChartDimension * 0.007)); // Scale circle radius
    const baseStrokeWidth = Math.max(1, Math.min(2, baseChartDimension * 0.002)); // Scale stroke width
    const gridLineStrokeWidth = Math.max(0.5, Math.min(1, baseChartDimension * 0.001)); // Thinner grid lines

    // --- New Color Logic ---
    const dates = data.map(d => new Date(d.date).getTime());
    const minDate = Math.min(...dates);
    const maxDate = Math.max(...dates);
    const dateRange = maxDate - minDate || 1;

    const colorToRgb = (color) => {
      const div = document.createElement('div');
      div.style.color = color;
      document.body.appendChild(div);
      const computedColor = window.getComputedStyle(div).color;
      document.body.removeChild(div);
      const [r, g, b] = computedColor.match(/\d+/g).map(Number);
      return { r, g, b };
    }

    const getGradientColor = (startColor, endColor, ratio) => {
      const s = colorToRgb(startColor);
      const e = colorToRgb(endColor);
      const r = Math.round(s.r + (e.r - s.r) * ratio);
      const g = Math.round(s.g + (e.g - s.g) * ratio);
      const b = Math.round(s.b + (e.b - s.b) * ratio);
      return `rgb(${r}, ${g}, ${b})`;
    }

    let periods;
    if (this.config.color_periods && this.config.color_periods.length > 0) {
      periods = this.config.color_periods.map(p => ({
        endDate: p.endDate === 'now' ? new Date(maxDate) : new Date(p.endDate),
        startColor: p.startColor,
        endColor: p.endColor,
        name: p.name || '',
        setpoint: p.setpoint,
      })).sort((a, b) => a.endDate - b.endDate);
    }

    const getAppearanceForPoint = (dateStr) => {
      const timestamp = new Date(dateStr).getTime();

      if (!periods) {
        // Fallback to original behavior
        const ratio = (timestamp - minDate) / dateRange;
        const hue = 120 * (1 - ratio);
        return { color: `hsl(${hue}, 70%, 50%)`, name: '' };
      }

      // Find the correct period for the current data point
      let period = periods.find(p => timestamp <= p.endDate.getTime());
      if (!period) {
        // If not in any period, use the last one (for points after the last defined endDate, if it's not 'now')
        period = periods[periods.length - 1];
      }

      const periodIndex = periods.indexOf(period);
      const periodStartDate = periodIndex === 0 ? minDate : periods[periodIndex - 1].endDate.getTime();
      const periodEndDate = period.endDate.getTime();
      
      const periodDuration = periodEndDate - periodStartDate;
      const timeInPeriod = timestamp - periodStartDate;
      const ratio = periodDuration > 0 ? Math.max(0, Math.min(1, timeInPeriod / periodDuration)) : 1;

      return {
        color: getGradientColor(period.startColor, period.endColor, ratio),
        name: period.name,
        setpoint: period.setpoint,
      };
    };
    // --- End of New Color Logic ---

    const solveLinearSystem = (A_in, B_in) => {
        const n = A_in.length;
        const A = A_in.map(row => [...row]);
        const B = [...B_in];

        for (let i = 0; i < n; i++) {
            A[i].push(B[i]);
        }

        for (let i = 0; i < n; i++) {
            let maxEl = Math.abs(A[i][i]);
            let maxRow = i;
            for (let k = i + 1; k < n; k++) {
                if (Math.abs(A[k][i]) > maxEl) {
                    maxEl = Math.abs(A[k][i]);
                    maxRow = k;
                }
            }

            [A[i], A[maxRow]] = [A[maxRow], A[i]];

            if (Math.abs(A[i][i]) < 1e-10) {
                return null;
            }

            const pivot = A[i][i];
            for (let j = i; j < n + 1; j++) {
                A[i][j] /= pivot;
            }

            for (let k = 0; k < n; k++) {
                if (k !== i) {
                    const factor = A[k][i];
                    for (let j = i; j < n + 1; j++) {
                        A[k][j] -= factor * A[i][j];
                    }
                }
            }
        }

        const solution = Array(n).fill(0);
        for (let i = 0; i < n; i++) {
            solution[i] = A[i][n];
        }
        return solution;
    };

    const polynomialRegression = (data, degree = 2) => {
        const n = data.length;
        if (n < degree + 1) return null;

        const A = Array(degree + 1).fill(0).map(() => Array(degree + 1).fill(0));
        const B = Array(degree + 1).fill(0);

        for (const { x, y } of data) {
            for (let i = 0; i <= degree; i++) {
                B[i] += y * Math.pow(x, i);
                for (let j = 0; j <= degree; j++) {
                    A[i][j] += Math.pow(x, i + j);
                }
            }
        }

        const coeffs = solveLinearSystem(A, B);
        if (!coeffs) return null;

        return (x) => coeffs.reduce((sum, coeff, i) => sum + coeff * Math.pow(x, i), 0);
    };

    data.forEach(point => {
        const appearance = getAppearanceForPoint(point.date);
        point.color = appearance.color;
        point.periodName = appearance.name;
        point.periodSetpoint = appearance.setpoint;
    });

    const pointsByPeriod = data.reduce((acc, point) => {
        const key = point.periodName || 'Default';
        if (!acc[key]) {
            acc[key] = [];
        }
        acc[key].push(point);
        return acc;
    }, {});

    const trendLines = Object.keys(pointsByPeriod).map(periodName => {
        const periodPoints = pointsByPeriod[periodName];
        if (periodPoints.length < 3) return null;

        const lastPoint = periodPoints.reduce((latest, current) => {
            return new Date(current.date) > new Date(latest.date) ? current : latest;
        });
        const trendLineColor = lastPoint.color;
        
        const regressionData = periodPoints.map(p => ({ x: p.outside_temp, y: p.scop }));
        const trend = polynomialRegression(regressionData, 2);

        return { name: periodName, trend, color: trendLineColor };
    }).filter(t => t);


    // Create scales
    const scaleX = (value) => padding.left + ((value - minTemp) / (maxTemp - minTemp)) * chartWidth;
    const scaleY = (value) => height - padding.bottom - ((value - minScop) / (maxScop - minScop)) * chartHeight;

    // Generate axis ticks
    const xTicks = this.generateTicks(minTemp, maxTemp, 8);
    const yTicks = this.generateTicks(minScop, maxScop, 8);

    // Generate grid lines
    const gridLines = xTicks.map(tick => `
      <line x1="${scaleX(tick)}" y1="${padding.top}"
            x2="${scaleX(tick)}" y2="${height - padding.bottom}"
            stroke="#c0c0c0" stroke-width="${gridLineStrokeWidth}" />
    `).join('') + yTicks.map(tick => `
      <line x1="${padding.left}" y1="${scaleY(tick)}"
            x2="${width - padding.right}" y2="${scaleY(tick)}"
            stroke="#c0c0c0" stroke-width="${gridLineStrokeWidth}" />
    `).join('');

    // Generate axis labels
    const xAxisLabels = xTicks.map(tick => `
      <text x="${scaleX(tick)}" y="${height - padding.bottom + 20}"
            text-anchor="middle" font-size="${baseSvgFontSize}" class="tick-label">
        ${tick.toFixed(1)}
      </text>
    `).join('');

    const yAxisLabels = yTicks.map(tick => `
      <text x="${padding.left - 10}" y="${scaleY(tick) + 4}"
            text-anchor="end" font-size="${baseSvgFontSize}" class="tick-label">
        ${tick.toFixed(1)}
      </text>
    `).join('');

    // Generate data points
    const points = data.map((point, i) => {
      const cx = scaleX(point.outside_temp);
      const cy = scaleY(point.scop);
      const { color, name } = getAppearanceForPoint(point.date);
      const dateFormatted = new Date(point.date).toLocaleDateString('en-GB', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
      const isLatest = i === data.length - 1;

      const attributes = `
        fill="${color}"
        data-index="${i}"
        data-date="${dateFormatted}"
        data-outside-temp="${point.outside_temp.toFixed(1)}"
        data-scop="${point.scop.toFixed(2)}"
        data-energy-in="${point.energy_in.toFixed(2)}"
        data-energy-out="${point.energy_out.toFixed(2)}"
        data-type="${point.type}"
        data-period-name="${name}"
        style="cursor: pointer;"
      `;

      if (this.config.scop_type === 'both' && point.type === 'dhw') {
        const size = baseCircleRadius * 2;
        const x = cx - baseCircleRadius;
        const y = cy - baseCircleRadius;
        return `
          <rect x="${x}" y="${y}" width="${size}" height="${size}"
                class="data-point"
                ${attributes}>
          </rect>
        `;
      } else {
        const pointClass = `data-point ${isLatest && this.config.scop_type !== 'both' ? 'latest-point' : ''}`;
        return `
          <circle cx="${cx}" cy="${cy}" r="${baseCircleRadius}"
                  class="${pointClass}"
                  ${attributes}>
          </circle>
        `;
      }
    }).join('');

    const trendLineElements = trendLines.map(({ trend, color, name }) => {
        if (!trend || this.config.scop_type === 'combined' || this.config.scop_type === 'both') return '';

        const periodPoints = pointsByPeriod[name];
        const xValues = periodPoints.map(p => p.outside_temp);
        const minX = Math.min(...xValues);
        const maxX = Math.max(...xValues);

        const linePoints = [];
        const segments = 20;
        for (let i = 0; i <= segments; i++) {
            const x = minX + (maxX - minX) * (i / segments);
            const y = trend(x);
            linePoints.push([scaleX(x), scaleY(y)]);
        }

        const pathData = linePoints.map((p, i) => (i === 0 ? 'M' : 'L') + p.join(' ')).join(' ');

        return `
            <path d="${pathData}"
                  stroke="${color}" stroke-width="2" fill="none" />
        `;
    }).join('');

    const periodStats = Object.keys(pointsByPeriod).map(periodName => {
        const periodPoints = pointsByPeriod[periodName];
        if (periodPoints.length === 0) return null;
        const periodScops = periodPoints.map(p => p.scop);
        const periodAvgScop = periodScops.reduce((sum, scop) => sum + scop, 0) / periodScops.length;
        
        const lastPoint = periodPoints.reduce((latest, current) => {
            return new Date(current.date) > new Date(latest.date) ? current : latest;
        });
        const periodColor = lastPoint.color;

        const periodSetpoint = periodPoints[0].periodSetpoint ?? this.config.setpoint;

        return {
            name: periodName,
            count: periodPoints.length,
            avgScop: periodAvgScop,
            color: periodColor,
            setpoint: periodSetpoint,
        };
    }).filter(p => p);

    const periodStatsHtml = periodStats.length > 0 ? `
        <div class="period-stats-container">
            ${periodStats.map(stat => `
                <div class="period-stat-item">
                    <div class="period-header" style="border-left-color: ${stat.color};
">
                        ${stat.name === 'Default' ? 'Summary' : stat.name}
                    </div>
                    <div class="info-grid">
                        <div class="info-item">
                            <div class="info-label">Data Points</div>
                            <div class="info-value">${stat.count}</div>
                        </div>
                        <div class="info-item">
                            <div class="info-label">Average SCOP</div>
                            <div class="info-value">${stat.avgScop.toFixed(2)}</div>
                        </div>
                        <div class="info-item">
                            <div class="info-label">Setpoint</div>
                            <div class="info-value">${stat.setpoint.toFixed(1)}<span class="info-unit">°C</span></div>
                        </div>
                    </div>
                </div>
            `).join('')}
        </div>
    ` : '';

    let legend = '';
    if (this.config.scop_type === 'both') {
      legend = `
        <g class="legend" transform="translate(${width - padding.right - 100}, ${padding.top})">
          <circle cx="5" cy="5" r="5" fill="none" stroke="var(--primary-text-color)"></circle>
          <text x="15" y="10" font-size="${baseSvgFontSize}" class="tick-label">CH</text>
          <rect x="0" y="20" width="10" height="10" fill="none" stroke="var(--primary-text-color)"></rect>
          <text x="15" y="30" font-size="${baseSvgFontSize}" class="tick-label">DHW</text>
        </g>
      `;
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { padding: 0; position: relative; font-size: 14px; } /* Base font size for the card */
        .chart-container-wrapper { padding: 16px; }
        .chart-title {
          text-align: center;
          font-size: 1.2em; /* Relative to ha-card font-size */
          font-weight: bold;
          margin-bottom: 8px;
          color: var(--primary-text-color);
        }
        .chart-subtitle {
          text-align: center;
          font-size: 0.85em; /* Relative to ha-card font-size */
          color: var(--secondary-text-color);
          margin-bottom: 12px;
        }
        .chart-container { position: relative; width: 100%; }
        svg { display: block; width: 100%; height: auto; max-width: 100%; }
        .data-point {
          --data-point-r: ${baseCircleRadius}px;
          --data-point-stroke-width: ${baseStrokeWidth}px;
          transition: transform 0.2s ease-in-out;
        }
        .data-point:hover {
          stroke-width: calc(var(--data-point-stroke-width) * 1.5);
          transform: scale(1.75);
          transform-box: fill-box;
          transform-origin: center;
        }
        @keyframes pulsate {
          0%, 100% { r: var(--data-point-r); opacity: 1; }
          50% { r: calc(var(--data-point-r) * 1.75); opacity: 0.7; }
        }
        .latest-point {
          animation: pulsate 2s ease-in-out infinite;
        }
        .axis-label { font-size: ${axisLabelFontSize}px; font-weight: bold; fill: var(--primary-text-color); }
        .tick-label { fill: var(--secondary-text-color); }
        .axis-line { stroke: var(--primary-text-color); opacity: 0.5; }
        .tooltip {
          position: absolute;
          background: rgba(0, 0, 0, 0.9);
          color: white;
          padding: 10px;
          border-radius: 4px;
          font-size: 0.9em; /* Relative to ha-card font-size */
          pointer-events: none;
          opacity: 0;
          transition: opacity 0.2s;
          z-index: 1000;
          white-space: nowrap;
        }
        .tooltip.visible { opacity: 1; }
        .period-stats-container {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 16px;
            margin-top: 16px;
        }
        .period-stat-item {
            background: var(--card-background-color);
            padding: 12px;
            border-radius: 8px;
            border: 1px solid var(--divider-color);
        }
        .period-header {
            font-size: 1.1em;
            font-weight: bold;
            color: var(--primary-text-color);
            margin-bottom: 12px;
            padding-left: 8px;
            border-left: 4px solid;
        }
        .info-grid {
            display: flex;
            justify-content: space-around;
        }
        .info-item { text-align: center; flex: 1; }
        .info-label {
          font-size: 0.85em; /* Relative to ha-card font-size */
          color: var(--secondary-text-color);
          margin-bottom: 4px;
        }
        .info-value {
          font-size: 1.2em; /* Relative to ha-card font-size */
          font-weight: bold;
          color: var(--primary-text-color);
        }
        .info-unit {
          font-size: 1em; /* Relative to ha-card font-size */
          color: var(--secondary-text-color);
          margin-left: 2px;
        }
      </style>
      <ha-card>
        ${this.renderControls()}
        <div class="chart-container-wrapper">
          <div class="chart-title">${title}</div>
          <div class="chart-subtitle">
            Based on ${data.length} days of Home Assistant long-term statistics
          </div>
          <div class="chart-container">
          <div class="tooltip"></div>
          <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">
            ${gridLines}
            <line x1="${padding.left}" y1="${padding.top}"
                  x2="${padding.left}" y2="${height - padding.bottom}"
                  class="axis-line" stroke-width="${baseStrokeWidth}" />
            <line x1="${padding.left}" y1="${height - padding.bottom}"
                  x2="${width - padding.right}" y2="${height - padding.bottom}"
                  class="axis-line" stroke-width="${baseStrokeWidth}" />
            ${xAxisLabels}
            ${yAxisLabels}
            <text x="${width / 2}" y="${height - 10}"
                  text-anchor="middle" class="axis-label">
              Outside Temperature (°C)
            </text>
            <text x="${-(height / 2)}" y="15"
                  text-anchor="middle" class="axis-label"
                  transform="rotate(-90)">
              System SCOP
            </text>
            ${points}
            ${trendLineElements}
            ${legend}
          </svg>
          </div>
          ${periodStatsHtml}
        </div>
      </ha-card>
    `;

    this.setupControlListeners();
    this.setupTooltip();
  }

  setupTooltip() {
    const tooltip = this.shadowRoot.querySelector('.tooltip');
    const points = this.shadowRoot.querySelectorAll('.data-point');

    points.forEach(point => {
      point.addEventListener('mouseenter', (e) => {
        const date = e.target.getAttribute('data-date');
        const outsideTemp = e.target.getAttribute('data-outside-temp');
        const scop = e.target.getAttribute('data-scop');
        const energyIn = e.target.getAttribute('data-energy-in');
        const energyOut = e.target.getAttribute('data-energy-out');
        const type = e.target.getAttribute('data-type');
        const periodName = e.target.getAttribute('data-period-name');

        let typeLabel = '';
        if (this.config.scop_type === 'both') {
            typeLabel = `Type: ${type.toUpperCase()}<br>`;
        }
        
        let mainTitle = `<strong>${date}</strong>`;
        if (periodName) {
            mainTitle += ` | ${periodName}`;
        }

        tooltip.innerHTML = `
          ${mainTitle}<br>
          ${typeLabel}
          SCOP: ${scop}<br>
          Energy In: ${energyIn} kWh<br>
          Energy Out: ${energyOut} kWh<br>
          Outside Temp: ${outsideTemp}°C<br>
        `;
        tooltip.classList.add('visible');
      });

      point.addEventListener('mousemove', (e) => {
        const container = this.shadowRoot.querySelector('.chart-container');
        const rect = container.getBoundingClientRect();
        
        // Handle both mouse and touch events
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;

        const relativeX = clientX - rect.left;

        // Position tooltip to the left if in the right third of the chart, otherwise to the right
        if (relativeX > (rect.width * 2 / 3)) {
          tooltip.style.left = (relativeX - tooltip.offsetWidth - 15) + 'px';
        } else {
          tooltip.style.left = (relativeX + 15) + 'px';
        }
        tooltip.style.top = (clientY - rect.top - 15) + 'px';
      });

      point.addEventListener('mouseleave', () => {
        tooltip.classList.remove('visible');
      });
    });
  }

  generateTicks(min, max, count) {
    const range = max - min;
    const step = range / (count - 1);
    const ticks = [];
    for (let i = 0; i < count; i++) {
      ticks.push(min + (step * i));
    }
    return ticks;
  }

  getCardSize() {
    return 5;
  }

  static getConfigElement() {
    return document.createElement('heat-pump-scop-card-editor');
  }

  static getStubConfig() {
    return {
      days: 365,
      setpoint: 21.0,
      title: 'Heat Pump SCOP Performance',
      width: 700,
      height: 400,
      scop_type: 'ch',
      energy_in_threshold: 0.1,
    };
  }
}

class HeatPumpSCOPCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = {
      days: 365,
      setpoint: 21.0,
      title: 'Heat Pump SCOP Performance',
      width: 700,
      height: 400,
      scop_type: 'ch',
      cop_threshold: 1.0,
      energy_in_threshold: 0.1,
      ...config
    };
    this.render();
  }

  configChanged(newConfig) {
    const event = new Event('config-changed', {
      bubbles: true,
      composed: true,
    });
    event.detail = { config: newConfig };
    this.dispatchEvent(event);
  }

  render() {
    if (!this._config) {
      return;
    }

    const config = this._config;

    this.innerHTML = `
      <style>
        .config-row {
          display: flex;
          align-items: center;
          padding: 8px 0;
        }
        .config-label {
          flex: 1;
          font-weight: 500;
        }
        .config-input {
          flex: 2;
        }
        .config-section {
          margin-top: 16px;
          padding-top: 16px;
          border-top: 1px solid var(--divider-color);
        }
        .config-section-title {
          font-size: 14px;
          font-weight: 600;
          color: var(--primary-text-color);
          margin-bottom: 8px;
        }
        ha-textfield {
          width: 100%;
        }
        .helper-text {
          font-size: 12px;
          color: var(--secondary-text-color);
          margin-top: 4px;
        }
      </style>

      <div class="config-section">
        <div class="config-section-title">Display Settings</div>

        <div class="config-row">
          <div class="config-label">Card Title</div>
          <div class="config-input">
            <ha-textfield
              type="text"
              value="${config.title}"
              configValue="title"
            ></ha-textfield>
            <div class="helper-text">Title displayed on the card</div>
          </div>
        </div>

        <div class="config-row">
          <div class="config-label">Chart Width</div>
          <div class="config-input">
            <ha-textfield
              type="number"
              value="${config.width}"
              configValue="width"
              min="400"
              max="2000"
            ></ha-textfield>
            <div class="helper-text">Chart width in pixels (400-2000)</div>
          </div>
        </div>

        <div class="config-row">
          <div class="config-label">Chart Height</div>
          <div class="config-input">
            <ha-textfield
              type="number"
              value="${config.height}"
              configValue="height"
              min="300"
              max="1000"
            ></ha-textfield>
            <div class="helper-text">Chart height in pixels (300-1000)</div>
          </div>
        </div>
      </div>

      <div class="config-section">
        <div class="config-section-title">Data Analysis</div>

        <div class="config-row">
          <div class="config-label">Days of History</div>
          <div class="config-input">
            <ha-textfield
              type="number"
              value="${config.days}"
              configValue="days"
              min="1"
              max="3650"
            ></ha-textfield>
            <div class="helper-text">How many days of historical data to query (1-3650)</div>
          </div>
        </div>

        <div class="config-row">
          <div class="config-label">Indoor Setpoint</div>
          <div class="config-input">
            <ha-textfield
              type="number"
              value="${config.setpoint}"
              configValue="setpoint"
              step="0.1"
            ></ha-textfield>
            <div class="helper-text">Target indoor temperature in °C</div>
          </div>
        </div>

        <div class="config-row">
          <div class="config-label">COP Threshold</div>
          <div class="config-input">
            <ha-textfield
              type="number"
              value="${config.cop_threshold}"
              configValue="cop_threshold"
              step="0.1"
            ></ha-textfield>
            <div class="helper-text">Filter out daily COP values below this threshold.</div>
          </div>
        </div>
        
        <div class="config-row">
          <div class="config-label">Energy In Threshold</div>
          <div class="config-input">
            <ha-textfield
              type="number"
              value="${config.energy_in_threshold}"
              configValue="energy_in_threshold"
              step="0.01"
            ></ha-textfield>
            <div class="helper-text">Filter out daily data points with energy input below this threshold (kWh).</div>
          </div>
        </div>

        <div class="config-row">
          <div class="config-label">SCOP Type</div>
          <div class="config-input">
            <select class="scop-type-config" style="width: 100%; padding: 8px; border-radius: 4px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color);">
              <option value="ch" ${config.scop_type === 'ch' ? 'selected' : ''}>Central Heating Only</option>
              <option value="combined" ${config.scop_type === 'combined' ? 'selected' : ''}>Combined (CH + DHW)</option>
              <option value="dhw" ${config.scop_type === 'dhw' ? 'selected' : ''}>Domestic Hot Water Only</option>
              <option value="both" ${config.scop_type === 'both' ? 'selected' : ''}>Both (CH and DHW separate)</option>
            </select>
            <div class="helper-text">Which SCOP value to display on the chart</div>
          </div>
        </div>
      </div>
    `;

    // Set up event listeners after rendering
    this.querySelectorAll('ha-textfield').forEach(field => {
      field.addEventListener('input', this._valueChanged.bind(this));
    });

    const scopTypeConfig = this.querySelector('.scop-type-config');
    if (scopTypeConfig) {
      scopTypeConfig.addEventListener('change', (e) => {
        this._valueChanged({ target: { getAttribute: () => 'scop_type', value: e.target.value } });
      });
    }
  }

  _valueChanged(ev) {
    if (!this._config || !ev.target) {
      return;
    }
    const target = ev.target;
    const configValue = target.getAttribute('configValue');
    let value = target.value;

    if (!configValue) {
      return;
    }

    // Convert numeric fields
    if (['days', 'setpoint', 'width', 'height', 'cop_threshold', 'energy_in_threshold'].includes(configValue)) {
      value = parseFloat(value);
    }

    if (this._config[configValue] === value) {
      return;
    }

    const newConfig = {
      ...this._config,
      [configValue]: value,
    };

    this.configChanged(newConfig);
  }
}

customElements.define('heat-pump-scop-card', HeatPumpSCOPCard);
customElements.define('heat-pump-scop-card-editor', HeatPumpSCOPCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'heat-pump-scop-card',
  name: 'Heat Pump SCOP Card',
  description: 'A scatter plot showing SCOP vs temperature difference from Home Assistant long-term statistics'
});
