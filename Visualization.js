viewof selection = {
  const form = html`<form style="display:none"></form>`;
  form.value = { countyFips: null, providerId: null };
  form.update = (patch) => {
    Object.assign(form.value, patch);
    form.dispatchEvent(new InputEvent("input", {bubbles: true}));
  };
  return form;
}

viewof topN = Inputs.number({
  label:"Top counties per state",
  value:10,
  min:1,
  max:50,
  step:1
})

loaders = {
  // helpers
  const num  = v => (v == null || v === "" ? null : +v);
  const pad5 = s => (s ?? "").toString().padStart(5, "0");
  const pad6 = s => (s ?? "").toString().replace(/\D/g,"").padStart(6, "0");

  const countiesRaw  = await FileAttachment("counties_2023@1.csv").csv({typed:false});
  const hospitalsRaw = await FileAttachment("hospitals_2025@1.csv").csv({typed:false});
  const top5Raw      = await FileAttachment("hospital_drg_top5@1.csv").csv({typed:false});
  const regionGeo    = await FileAttachment("counties_geo_region@1.json").json();

  let counties = countiesRaw.map(d => ({
    fips: pad5(d.fips),
    state: d.state,                // two-letter abbr
    county_name: d.county_name,
    spend: num(d.spend),
    quality: num(d.quality_bedweighted),
    z_spend:  num(d.z_spend),
    z_quality: num(d.z_quality),
    beds_sum: num(d.beds_sum),
    discharges_sum: num(d.discharges_sum)
  }));

  const nums = A => A.filter(v => v != null && !isNaN(v));
  const zs = (arr) => {
    const v = nums(arr);
    const mu = d3.mean(v), sd = d3.deviation(v);
    return arr.map(x => (x == null || sd == null || sd === 0) ? null : (x - mu)/sd);
  };
  if (!counties.some(d => d.z_spend != null))   {
    const z = zs(counties.map(d=>d.spend));
    counties = counties.map((d,i)=>({...d, z_spend:z[i]}));
  }
  if (!counties.some(d => d.z_quality != null)) {
    const z = zs(counties.map(d=>d.quality));
    counties = counties.map((d,i)=>({...d, z_quality:z[i]}));
  }

  const hospitals = hospitalsRaw.map(d => ({
    provider_id: pad6(d.provider_id),
    name: d.name,
    state: d.state,
    fips: pad5(d.fips),
    stars: num(d.stars),
    beds: num(d.beds),
    ownership: d.ownership,
    hhi: num(d.hhi),
    wavg_payment: num(d.wavg_payment),
    med_share: num(d.med_share),
    surg_share: num(d.surg_share)
  }));

  const top5 = top5Raw.map(d => ({
    provider_id: pad6(d.provider_id),
    rank: +d.rank,
    drg_code: d.drg_code,
    drg_desc: d.drg_desc,
    share: num(d.share),
    avg_medicare_payment: num(d.avg_medicare_payment)
  }));

  const regionStates = ["MI","OH","IN","IL","WI"];

  const countyByFips = new Map(counties.map(d => [d.fips, d]));
  const drgByHosp = d3.group(top5, d => d.provider_id);
  const ownerships = Array.from(new Set(hospitals.map(d => d.ownership)))
    .filter(Boolean)
    .sort();

  function topCountyFipsByState(metric = "discharges_sum", N = 10) {
    const filtered = counties.filter(d => regionStates.includes(d.state));
    const grouped = d3.group(filtered, d => d.state);
    const keep = new Set();
    for (const [st, arr] of grouped) {
      arr.sort((a,b) => d3.descending(+a[metric] || 0, +b[metric] || 0));
      for (const d of arr.slice(0, N)) keep.add(d.fips);
    }
    return keep;
  }

  return {
    counties,
    hospitals,
    top5,
    regionGeo,
    countyByFips,
    drgByHosp,
    ownerships,
    regionStates,
    topCountyFipsByState
  };
}

viewof filt_ownership = Inputs.select(loaders.ownerships, {
  label:"Ownership",
  multiple:true
})

viewof search_hosp = Inputs.text({
  label:"Search hospital (optional)",
  placeholder:"type to filter scatter..."
})

regionMap = (() => {
  const {counties, regionGeo, countyByFips, topCountyFipsByState} = loaders;

  const N = (viewof topN).value ?? 10;

 
  const keepFips = topCountyFipsByState("discharges_sum", N);

  const width  = 540, height = 360;
  const margin = {top: 10, right: 10, bottom: 10, left: 10};

 
  const zMin = -2.0;
  const zMax =  2.0;
  const colorSpend = d3.scaleSequential()
    .domain([zMin, zMax])
    .interpolator(d3.interpolateYlOrRd);

  const svg = d3.create("svg").attr("width", width).attr("height", height);
  const proj = d3.geoAlbersUsa()
    .fitExtent([[margin.left, margin.top],[width - margin.right, height - margin.bottom]], regionGeo);
  const path = d3.geoPath(proj);

  const g = svg.append("g");

 
  g.selectAll("path")
    .data(regionGeo.features)
    .join("path")
      .attr("d", path)
      .attr("fill", f => {
        const row = countyByFips.get(f.properties.fips);
        if (!row) return "#eee";
        if (!keepFips.has(row.fips)) return "#f0f0f0";  
        return Number.isFinite(+row.z_spend) ? colorSpend(+row.z_spend) : "#eee";
      })
      .attr("stroke", "#fff")
      .attr("stroke-width", 0.75)
      .on("click", (ev, f) => {
        (viewof selection).update({ countyFips: f.properties.fips, providerId: null });
      })
      .append("title")
        .text(f => {
          const c = countyByFips.get(f.properties.fips);
          if (!c) return `${f.properties.county_name}, ${f.properties.state}\n(no data)`;
          return `${c.county_name}, ${c.state}\nSpend z: ${d3.format(".2f")(c.z_spend ?? NaN)}  Quality z: ${d3.format(".2f")(c.z_quality ?? NaN)}`;
        });

  const sel = selection.countyFips;
  if (sel) {
    const feat = regionGeo.features.find(f => f.properties.fips === sel);
    if (feat) g.append("path").datum(feat).attr("d", path)
      .attr("fill","none").attr("stroke","#111").attr("stroke-width",2);
  }

  const groupedStates = d3.group(regionGeo.features, f => f.properties.state);

  for (const [st, feats] of groupedStates) {
    let cx = 0, cy = 0, n = 0;
    for (const f of feats) {
      const [x, y] = path.centroid(f);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        cx += x; cy += y; n += 1;
      }
    }
    if (n > 0) {
      g.append("text")
        .attr("x", cx / n)
        .attr("y", cy / n)
        .attr("text-anchor", "middle")
        .attr("dy", "0.35em")
        .attr("font-weight", 700)
        .attr("font-size", 11)
        .attr("fill", "#333")
        .text(st);
    }
  }

  svg.append("text")
    .attr("x", width / 2)
    .attr("y", 20)
    .attr("text-anchor", "middle")
    .attr("font-weight", 700)
    .text(`Top ${N} counties per state by total discharges`);

  const legendWidth = 140;
  const legendHeight = 10;

  const defs = svg.append("defs");
  const gradient = defs.append("linearGradient")
    .attr("id", "legend-zspend")
    .attr("x1", "0%").attr("x2", "100%")
    .attr("y1", "0%").attr("y2", "0%");

  const legendSteps = d3.range(0, 1.0001, 0.1);
  legendSteps.forEach(t => {
    const z = zMin + t * (zMax - zMin);
    gradient.append("stop")
      .attr("offset", `${t * 100}%`)
      .attr("stop-color", colorSpend(z));
  });

  const legendGroup = svg.append("g")
    .attr("transform", `translate(16, ${height - 50})`)
    .attr("font-size", 10);

  const legendScale = d3.scaleLinear()
    .domain([zMin, zMax])
    .range([0, legendWidth]);

  legendGroup.append("rect")
    .attr("width", legendWidth)
    .attr("height", legendHeight)
    .attr("fill", "url(#legend-zspend)");

  legendGroup.append("g")
    .attr("transform", `translate(0, ${legendHeight})`)
    .call(d3.axisBottom(legendScale).ticks(5).tickFormat(d3.format(".1f")))
    .attr("font-size", 9);

  legendGroup.append("text")
    .attr("x", 0).attr("y", -6)
    .attr("font-weight", 600)
    .text("County z_spend");
  legendGroup.append("text")
    .attr("x", 0).attr("y", legendHeight + 30)
    .attr("font-size", 9)
    .text("(standardized spend)");

  return svg.node();
})();

hospitalScatter = (() => {
  const {hospitals, countyByFips, topCountyFipsByState, ownerships} = loaders;

  const N = (viewof topN).value ?? 10;
  const keepFips = topCountyFipsByState("discharges_sum", N);

  const width  = 540, height = 360;
  const margin = {top: 48, right: 150, bottom: 40, left: 60};
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const selFips = selection.countyFips;
  const text = (viewof search_hosp).value?.toLowerCase().trim() ?? "";
  const own = (viewof filt_ownership).value ?? [];

  const base = hospitals.filter(d => keepFips.has(d.fips));
  const filteredHosp = base
    .filter(d => !selFips || d.fips === selFips)
    .filter(d => own.length === 0 || own.includes(d.ownership))
    .filter(d => text === "" || (d.name || "").toLowerCase().includes(text));

  if (filteredHosp.length === 0) {
    return html`<div style="padding:10px;border:1px dashed #ccc;border-radius:8px;font:12px/1.35 system-ui;width:${width}px;height:${height - 12}px;display:flex;align-items:center;justify-content:center;">
      No hospitals match the current filters. Try clearing Ownership or Search, or click a different county on the map.
    </div>`;
  }

  const county = selFips ? countyByFips.get(selFips) : null;
  const title = county ? `${county.county_name}, ${county.state}` : "Top-N counties (5-state region)";
  const xBase = county?.z_spend ?? 0;

  const svg = d3.create("svg").attr("width", width).attr("height", height);
  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  const x = d3.scaleLinear().domain([xBase-1.5, xBase+1.5]).range([0, innerW]);
  const y = d3.scaleLinear().domain([0, 5]).nice().range([innerH, 0]);
  const r = d3.scaleSqrt().domain(d3.extent(filteredHosp, d=>d.beds||1)).range([2, 10]);

  g.append("g").attr("transform", `translate(0,${innerH})`).call(d3.axisBottom(x));
  g.append("g").call(d3.axisLeft(y).ticks(6));

  g.append("text")
    .attr("x", innerW/2).attr("y", innerH+32)
    .attr("text-anchor","middle")
    .text("Market z_spend (county)");

  g.append("text")
    .attr("transform", `rotate(-90)`)
    .attr("x", -innerH/2)
    .attr("y", -40)
    .attr("text-anchor","middle")
    .text("Hospital stars");

  g.append("line")
    .attr("x1", x(xBase)).attr("x2", x(xBase)).attr("y1", 0).attr("y2", innerH)
    .attr("stroke", "#bbb").attr("stroke-dasharray", "3,3");

  const col = d3.scaleOrdinal(d3.schemeTableau10).domain(ownerships);
  const jitter = () => (Math.random() - 0.5) * 0.15;

  g.selectAll("circle").data(filteredHosp).enter().append("circle")
    .attr("cx", d => x(xBase + jitter()))
    .attr("cy", d => y(d.stars ?? 0))
    .attr("r", d => r(d.beds || 1))
    .attr("fill", d => col(d.ownership))
    .attr("opacity", 0.85)
    .on("click", (ev,d) => (viewof selection).update({ countyFips: d.fips, providerId: d.provider_id }))
    .append("title")
      .text(d => `${d.name}\nStars: ${d.stars ?? "—"}  Beds: ${d.beds ?? "—"}\nOwnership: ${d.ownership ?? "—"}`);

  svg.append("text")
    .attr("x", width/2).attr("y", 24)
    .attr("text-anchor","middle")
    .attr("font-weight",700)
    .text(`Hospital Quality vs Market — ${title}`);

    // ownership legend
  const legendX = width - margin.right - 60;      
  const legendY = margin.top;               

  const legend = svg.append("g")
    .attr("transform", `translate(${legendX}, ${legendY})`)
    .attr("font-size", 10);                  

  legend.append("text")
    .attr("x", 0).attr("y", -6)
    .attr("font-weight", 600)
    .text("Ownership");

  ownerships.forEach((o, i) => {
    const row = legend.append("g").attr("transform", `translate(0, ${i*14})`);
    row.append("rect")
      .attr("width", 10).attr("height", 10)
      .attr("fill", col(o));
    row.append("text")
      .attr("x", 14).attr("y", 9)
      .text(o);
  });

  return svg.node();
})();

drgBars = (() => {
  const {hospitals, drgByHosp} = loaders;
  const pid  = selection.providerId;
  const drgs = pid ? (drgByHosp.get(pid) || [])
                      .slice()
                      .sort((a,b) => d3.ascending(a.rank, b.rank))
                   : [];

  const width  = 540, height = 360;
  const margin = { top: 40, right: 120, bottom: 40, left: 280 };
  const innerW = width  - margin.left - margin.right;
  const innerH = height - margin.top  - margin.bottom;

  if (!pid || drgs.length === 0) {
    return html`<div style="width:${width}px;height:${height-6}px;border:1px dashed #ccc;border-radius:8px;
                            display:flex;align-items:center;justify-content:center;font:12px/1.35 system-ui;">
      Pick a hospital (scatter) to see Top-5 DRGs.
    </div>`;
  }

  const svg = d3.create("svg").attr("width", width).attr("height", height);
  const g   = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  const x = d3.scaleLinear()
    .domain([0, d3.max(drgs, d => +d.share || 0)]).nice()
    .range([0, innerW]);

  const y = d3.scaleBand()
    .domain(drgs.map(d => d.drg_desc))
    .range([0, innerH])
    .paddingInner(0.2);

  g.selectAll("rect")
    .data(drgs)
    .join("rect")
      .attr("x", 0)
      .attr("y", d => y(d.drg_desc))
      .attr("height", y.bandwidth())
      .attr("width", d => x(+d.share || 0))
      .attr("fill", "steelblue");

  const fmtPct = d3.format(".1%");
  g.selectAll("text.value")
    .data(drgs)
    .join("text")
      .attr("class", "value")
      .attr("x", d => x(+d.share || 0) + 6)
      .attr("y", d => (y(d.drg_desc) ?? 0) + y.bandwidth()/2)
      .attr("dominant-baseline", "middle")
      .attr("font-size", 8)
      .text(d => fmtPct(+d.share || 0));

  g.append("g")
    .call(d3.axisLeft(y).tickSizeOuter(0))
    .selectAll("text")
      .attr("font-size", 7);   
  
  g.append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(5).tickFormat(d3.format(".0%")));

  const title = hospitals.find(h => h.provider_id === pid)?.name ?? pid;

  const titleGroup = svg.append("g")
    .attr("transform", `translate(${width / 2}, 18)`);

  titleGroup.append("text")
    .attr("text-anchor", "middle")
    .attr("font-weight", 700)
    .attr("font-size", 12)
    .text(title);

  titleGroup.append("text")
    .attr("text-anchor", "middle")
    .attr("dy", "1.4em")
    .attr("font-size", 10)
    .text("Top 5 DRGs by discharge share");

  return svg.node();
})();

stateRanking = (() => {
  const {counties, regionStates} = loaders;

  const byState = d3.rollups(
    counties.filter(d => Number.isFinite(+d.z_spend) && regionStates.includes(d.state)),
    v => d3.mean(v, d => +d.z_spend),
    d => d.state
  ).map(([state, val]) => ({state, val}))
   .sort((a,b) => d3.descending(a.val, b.val));

  const width  = 540, height = 360;
  const margin = { top: 30, right: 40, bottom: 40, left: 60 };
  const innerW = width  - margin.left - margin.right;
  const innerH = height - margin.top  - margin.bottom;

  const x = d3.scaleLinear()
    .domain(d3.extent(byState, d => d.val)).nice()
    .range([0, innerW]);

  const y = d3.scaleBand()
    .domain(byState.map(d => d.state))
    .range([0, innerH])
    .paddingInner(0.2);

  const svg = d3.create("svg").attr("width", width).attr("height", height);
  const g   = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  g.selectAll("rect").data(byState).join("rect")
    .attr("x", d => Math.min(x(0), x(d.val)))
    .attr("y", d => y(d.state))
    .attr("width", d => Math.abs(x(d.val) - x(0)))
    .attr("height", y.bandwidth())
    .attr("fill", d => d.state === "MI" ? "#ffb703" : "#8ecae6");

  g.append("g").call(d3.axisLeft(y).tickSize(0)).selectAll("text").attr("font-size", 11);
  g.append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x));

  g.append("text")
    .attr("x", innerW/2)
    .attr("y", innerH + 32)
    .attr("text-anchor","middle")
    .text("Average county z_spend");

  svg.append("text")
    .attr("x", width/2).attr("y", 18)
    .attr("text-anchor","middle")
    .attr("font-weight",700)
    .text(`State ranking by z_spend (Michigan highlighted)`);

  return svg.node();
})();


{
  const wrap = html`<div style="
    max-width: 1200px;
    margin: 0 auto;
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-auto-rows: min-content;
    gap: 16px;
    align-items: start;
  "></div>`;

  const controls = html`<div style="
      grid-column: 1 / span 2;
      display:flex;
      gap:12px;
      align-items:center;
      flex-wrap:wrap;
    ">
    <div>${viewof topN}</div>
    <div>${viewof filt_ownership}</div>
    <div>${viewof search_hosp}</div>
  </div>`;
  wrap.append(controls);

  wrap.append(regionMap);
  wrap.append(hospitalScatter);
  wrap.append(drgBars);
  wrap.append(stateRanking);

  return wrap;
}

