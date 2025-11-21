// Simple mapping animations using Leaflet + Turf.js
// Exposes functions: drawCircle, splitMap, drawRoute, dropMarker
// Also includes an example scenario using Gold Coast stops.

const map = L.map('map', {zoomControl: true}).setView([-27.9671,153.4000], 13);

// Minimal unlabeled basemap (Carto Light, no labels)
const baseLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors & Carto'
}).addTo(map);

// LayerGroup to hold all animation-drawn items so we can clear them easily
const animationLayer = L.layerGroup().addTo(map);
// default duration (seconds) for map movements (flyTo / fitBounds)
const FLY_DURATION = 2.0;
// Separate layer for keyframe visual markers so we can hide them during playback
const keyframeLayer = L.layerGroup().addTo(map);
// Utility: convert [lng,lat] <-> Leaflet LatLng
function toLatLng(coord){ return L.latLng(coord[1], coord[0]); }
function toLngLat(latlng){ return [latlng.lng, latlng.lat]; }

// Helper: linear interpolation between two coords (lng,lat) in meters using turf
function interpolateAlong(line, distanceMeters){
  return turf.along(line, distanceMeters/1000, {units:'kilometers'}).geometry.coordinates;
}

// drawCircle: centreLngLat [lng,lat], radiusMeters, colorWhenFilled ('red'|'green'), id
function drawCircle(centreLngLat, radiusMeters, colorWhenFilled='red', opts={}){
  const id = opts.id || `circle-${Date.now()}`;
  const centre = toLatLng(centreLngLat);
  const circleOutline = L.circle(centre, {radius: radiusMeters, color: opts.outlineColor||'#f1c40f', weight:2, fill:false});
  animationLayer.addLayer(circleOutline);

  // After 5s shade semi-transparent
  setTimeout(()=>{
  const fill = L.circle(centre, {radius: radiusMeters, color: colorWhenFilled, weight:1, fill:true, fillOpacity:0.3});
  // replace outline with fill in animation layer
  animationLayer.removeLayer(circleOutline);
  animationLayer.addLayer(fill);
    // attach id
    fill._animId = id;
  }, 5000);

  return id;
}

// splitMap: split between pointA [lng,lat] and pointB [lng,lat]. After 5s shade side 'A' or 'B'
function splitMap(pointA, pointB, sideToShade='A', opts={}){
  // normalize coordinates to [lon,lat] if caller accidentally passed [lat,lon]
  function normalizeCoord(pt){
    if(!pt || pt.length<2) return pt;
    const x = Number(pt[0]), y = Number(pt[1]);
    // if first number looks like latitude (abs<=90) and second looks like longitude (abs>90), swap
    if(Math.abs(x) <= 90 && Math.abs(y) > 90) return [y, x];
    return [x,y];
  }

  pointA = normalizeCoord(pointA);
  pointB = normalizeCoord(pointB);

  // compute midpoint and perpendicular line
  const a = turf.point(pointA);
  const b = turf.point(pointB);
  const line = turf.lineString([pointA, pointB]);
  // Midpoint as arithmetic mean of coordinates (lon, lat)
  const midpoint = [(pointA[0] + pointB[0]) / 2, (pointA[1] + pointB[1]) / 2];

  // debug: drop a yellow marker at the computed midpoint, then remove after shading
  const midMarker = L.circleMarker(toLatLng(midpoint), {radius:7, fillColor:'#f1c40f', color:'#d35400', fillOpacity:1});
  animationLayer.addLayer(midMarker);

  // compute a perpendicular line in screen (pixel) space so it appears visually perpendicular
  const midLatLng = toLatLng(midpoint);
  const aLatLng = toLatLng(pointA);
  const bLatLng = toLatLng(pointB);
  const aPt = map.latLngToLayerPoint(aLatLng);
  const bPt = map.latLngToLayerPoint(bLatLng);
  const midPt = map.latLngToLayerPoint(midLatLng);

  // vector from A->B in pixels
  const vx = bPt.x - aPt.x;
  const vy = bPt.y - aPt.y;
  // perpendicular vector (-vy, vx)
  let px = -vy;
  let py = vx;
  const plen = Math.sqrt(px*px + py*py) || 1;
  px /= plen; py /= plen;

  // length to extend across map (use diagonal length)
  const size = map.getSize();
  const extend = Math.sqrt(size.x*size.x + size.y*size.y) * 1.5;

  const p1Pixel = L.point(midPt.x + px*extend, midPt.y + py*extend);
  const p2Pixel = L.point(midPt.x - px*extend, midPt.y - py*extend);
  const p1LatLng = map.layerPointToLatLng(p1Pixel);
  const p2LatLng = map.layerPointToLatLng(p2Pixel);
  const p1 = [p1LatLng.lng, p1LatLng.lat];
  const p2 = [p2LatLng.lng, p2LatLng.lat];
  const splitLine = L.polyline([p1LatLng, p2LatLng], {color:opts.lineColor||'#2c3e50', weight:2, dashArray:'6,8'});
  animationLayer.addLayer(splitLine);

  // draw small markers for A and B
  const ma = L.circleMarker(toLatLng(pointA),{radius:6,fillColor:'#e74c3c',color:'#c0392b',fillOpacity:1});
  const mb = L.circleMarker(toLatLng(pointB),{radius:6,fillColor:'#3498db',color:'#2980b9',fillOpacity:1});
  animationLayer.addLayer(ma);
  animationLayer.addLayer(mb);

  // After 5s shade the half-plane
  setTimeout(()=>{
    // Create a very large polygon on desired side using the split line plus far points
    // We'll create two polygons: polygonA on side where pointA lies, polygonB on other side
    // Use turf.booleanPointInPolygon to decide
    const bigPolyCoordsA = [p1, midpoint, p2].concat([p1]);
    const polyA = turf.polygon([[p1, midpoint, p2, p1]]);
    // But easier: construct a big polygon extending one side using buffer of the half-plane
    // We'll create a big rectangle and clip; as a simpler approach, create two polygons covering the globe split by line by creating a polygon from p1->p2->p2_far->p1_far

    // For robustness, generate polygon by rotating split line endpoints far and combining
    // construct rectangular shading polygons centered on each selected point
    // rectangle dimensions: half-length = 50 km along the midpoint->point direction, half-width = 50 km perpendicular
    function rectAround(centerPt, bearing){
      const halfLen = 50; // km
      const halfWid = 50; // km
      // endpoints along centerline
      const pF = turf.destination(turf.point(centerPt), halfLen, bearing, {units:'kilometers'}).geometry.coordinates;
      const pB = turf.destination(turf.point(centerPt), halfLen, bearing + 180, {units:'kilometers'}).geometry.coordinates;
      // perpendicular bearings
      const perp1 = bearing + 90;
      const perp2 = bearing - 90;
      const q1 = turf.destination(turf.point(pF), halfWid, perp1, {units:'kilometers'}).geometry.coordinates;
      const q2 = turf.destination(turf.point(pF), halfWid, perp2, {units:'kilometers'}).geometry.coordinates;
      const q3 = turf.destination(turf.point(pB), halfWid, perp2, {units:'kilometers'}).geometry.coordinates;
      const q4 = turf.destination(turf.point(pB), halfWid, perp1, {units:'kilometers'}).geometry.coordinates;
      return [q1, q2, q3, q4, q1];
    }

  // Build half-space polygons on either side of the perpendicular split line using pixel-space offsets.
  // p1Pixel and p2Pixel are the endpoints of the perpendicular in pixel space computed above.
  const bigPx = extend * 3; // how far to push the polygon away in pixels
  // compute normal (unit) from p1->p2
  const dx = p2Pixel.x - p1Pixel.x;
  const dy = p2Pixel.y - p1Pixel.y;
  let nx = -dy;
  let ny = dx;
  const nlen = Math.sqrt(nx*nx + ny*ny) || 1;
  nx /= nlen; ny /= nlen;

  // Ensure normal points towards pointA: if dot < 0 flip
  const toApx = aPt.x - p1Pixel.x;
  const toApy = aPt.y - p1Pixel.y;
  const dot = nx*toApx + ny*toApy;
  if(dot < 0){ nx = -nx; ny = -ny; }

  const p1_far = L.point(p1Pixel.x + nx*bigPx, p1Pixel.y + ny*bigPx);
  const p2_far = L.point(p2Pixel.x + nx*bigPx, p2Pixel.y + ny*bigPx);
  const p1_far_latlng = map.layerPointToLatLng(p1_far);
  const p2_far_latlng = map.layerPointToLatLng(p2_far);
  const ext1 = [p1_far_latlng.lng, p1_far_latlng.lat];
  const ext2 = [p2_far_latlng.lng, p2_far_latlng.lat];

  // polygon for side A (normal pointing to A): p1 -> p2 -> p2_far -> p1_far
  const polygonAcoords = [p1, p2, ext2, ext1, p1];
  // The opposite polygon (side B) built by offsetting in the negative normal direction
  const p1_far_b = L.point(p1Pixel.x - nx*bigPx, p1Pixel.y - ny*bigPx);
  const p2_far_b = L.point(p2Pixel.x - nx*bigPx, p2Pixel.y - ny*bigPx);
  const p1_far_b_latlng = map.layerPointToLatLng(p1_far_b);
  const p2_far_b_latlng = map.layerPointToLatLng(p2_far_b);
  const ext1b = [p1_far_b_latlng.lng, p1_far_b_latlng.lat];
  const ext2b = [p2_far_b_latlng.lng, p2_far_b_latlng.lat];
  const polygonBcoords_final = [p1, p2, ext2b, ext1b, p1];

    // decide polygons as GeoJSON
  const polyAGeo = turf.polygon([polygonAcoords]);
  const polyBGeo = turf.polygon([polygonBcoords_final]);

    // shade only the side requested by the user
    const shade = sideToShade === 'A' ? polyAGeo : polyBGeo;
    const colour = opts.color || (sideToShade==='A' ? '#e74c3c' : '#2ecc71');
  const leafletPoly = L.geoJSON(shade, {style:{color:colour, weight:0, fillColor:colour, fillOpacity:0.25}});
  animationLayer.addLayer(leafletPoly);
  // remove midpoint debug marker once shading has been applied
  if(midMarker) animationLayer.removeLayer(midMarker);

  }, 5000);
}

// drawRoute: points is array of [lng,lat]. speedMetersPerSecond controls how fast the drawing moves.
// returns a Promise that resolves when finished
function drawRoute(points, speedMetersPerSecond=120, opts={}){
  return new Promise((resolve, reject)=>{
    if(!points || points.length<2) return reject(new Error('Need at least 2 points'));
    // build a line
    const line = turf.lineString(points);
    const totalLengthKm = turf.length(line, {units:'kilometers'});
    const totalMeters = totalLengthKm*1000;

  // create a polyline for the drawn segment
  const drawn = L.polyline([], {color:opts.color||'#f1c40f', weight:4, opacity:1});
  const marker = L.circleMarker(toLatLng(points[0]), {radius:6,fillColor:opts.color||'#f1c40f',color:'#000',fillOpacity:1});
  animationLayer.addLayer(drawn);
  animationLayer.addLayer(marker);

    let traveled = 0; // meters
    const stepMs = 40; // update every 40ms
    const stepMeters = speedMetersPerSecond*(stepMs/1000);

    function step(){
      traveled += stepMeters;
      if(traveled > totalMeters) traveled = totalMeters;
      const coord = interpolateAlong(line, traveled);
      drawn.addLatLng(toLatLng(coord));
      marker.setLatLng(toLatLng(coord));
      if(traveled>=totalMeters){
        resolve();
      } else {
        requestAnimationFrame(()=> setTimeout(step, stepMs));
      }
    }
    step();
  });
}

// dropMarker: lnglat [lng,lat], color string (hex or css name), opts
function dropMarker(lnglat, color='#ff0000', opts={}){
  // normalize input similar to other helpers
  function normalizeCoord(pt){
    if(!pt || pt.length<2) return pt;
    const x = Number(pt[0]), y = Number(pt[1]);
    if(Math.abs(x) <= 90 && Math.abs(y) > 90) return [y, x];
    return [x,y];
  }
  const coord = Array.isArray(lnglat) ? normalizeCoord(lnglat) : null;
  if(!coord) return null;
  const latlng = toLatLng(coord);
  const marker = L.circleMarker(latlng, {
    radius: opts.radius || 8,
    fillColor: color || (opts.fillColor || '#ff0000'),
    color: opts.outlineColor || '#000',
    weight: opts.weight || 1,
    fillOpacity: opts.fillOpacity != null ? opts.fillOpacity : 1
  });
  animationLayer.addLayer(marker);
  if(opts.id) marker._animId = opts.id;
  return marker;
}

// Example: find coordinates for named places using Nominatim (public)
async function geocode(q){
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {headers:{'Accept':'application/json'}});
  const json = await res.json();
  if(!json || json.length===0) throw new Error('No results for '+q);
  return [parseFloat(json[0].lon), parseFloat(json[0].lat)];
}

// Try multiple query variants and return first success, or null if none
async function geocodeTry(queries){
  if(typeof queries === 'string') queries = [queries];
  for(const q of queries){
    try{
      const r = await geocode(q);
      return r;
    }catch(e){
      // try next
    }
  }
  return null;
}

// Hardcoded fallbacks for the demo locations (from OpenStreetMap)
const FALLBACK_COORDS = {
  southport: [153.4135598, -27.967894], // lon, lat
  mainBeach: [153.4234825, -27.982048],
  busStop: [153.4290483, -27.9825541]
};

// expose to window for interactive use
window.drawCircle = drawCircle;
window.splitMap = splitMap;
window.drawRoute = drawRoute;
window.dropMarker = dropMarker;
// placeKeyframe: capture current map center and zoom, show a small visual and return object
function placeKeyframe(opts={}){
  const center = map.getCenter();
  const zoom = map.getZoom();
  const centerCoords = [center.lng, center.lat];
  const id = opts.id || `keyframe-${Date.now()}`;
  // show a small visual marker at the center to indicate keyframe
  const marker = L.circleMarker(center, {
    radius: 6,
    fillColor: opts.color || '#2ecc71',
    color: opts.outlineColor || '#27ae60',
    weight: 1,
    fillOpacity: 0.95
  });
  marker._animId = id;
  // keyframe visuals live in their own layer so they can be hidden during playback
  keyframeLayer.addLayer(marker);
  return {id, center: centerCoords, zoom};
}
window.placeKeyframe = placeKeyframe;

// drawPolygon: outline then fill after 5s. points: array of [lon,lat]
function drawPolygon(points, fillColor='#ff0000', opts={}){
  if(!points || points.length<3) return null;
  // convert to Leaflet latlngs
  const latlngs = points.map(p=> toLatLng(p));
  const outline = L.polygon(latlngs, {color: opts.outlineColor||'#333', weight: opts.weight||2, fill:false});
  animationLayer.addLayer(outline);
  const id = opts.id || `polygon-${Date.now()}`;
  outline._animId = id;
  // after 5s fill with chosen colour
  setTimeout(()=>{
    // remove outline and add filled polygon (to keep behaviour consistent with drawCircle)
    animationLayer.removeLayer(outline);
    const filled = L.polygon(latlngs, {color: opts.outlineColor||'#333', weight: opts.weight||2, fill:true, fillColor: fillColor, fillOpacity: opts.fillOpacity!=null?opts.fillOpacity:0.25});
    filled._animId = id;
    animationLayer.addLayer(filled);
  }, 5000);
  return id;
}
window.drawPolygon = drawPolygon;


// Small helper to compute turf.bearing when missing
// turf.bearing requires two points as features - but older turf builds might differ. Provide fallback implementation if turf.bearing missing
if(!turf.bearing){
  turf.bearing = function(p1,p2){
    const lon1 = p1.geometry.coordinates[0]*Math.PI/180;
    const lat1 = p1.geometry.coordinates[1]*Math.PI/180;
    const lon2 = p2.geometry.coordinates[0]*Math.PI/180;
    const lat2 = p2.geometry.coordinates[1]*Math.PI/180;
    const y = Math.sin(lon2-lon1)*Math.cos(lat2);
    const x = Math.cos(lat1)*Math.sin(lat2) - Math.sin(lat1)*Math.cos(lat2)*Math.cos(lon2-lon1);
    const brng = Math.atan2(y,x)*180/Math.PI;
    return (brng+360)%360;
  }
}

// ----------------------
// Editor / Viewer UI
// ----------------------
const ui = {
  mode: 'editor', // 'editor' or 'viewer'
  animations: [] // {type:'circle'|'split'|'route', params:..., id}
};

const toolbar = document.getElementById('toolbar');
const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('overlay');
const overlayText = document.getElementById('overlayText');
const overlayInputs = document.getElementById('overlayInputs');
const overlayCancel = document.getElementById('overlayCancel');
const overlayStop = document.getElementById('overlayStop');
const modeToggle = document.getElementById('modeToggle');
const animList = document.getElementById('animList');

function setMode(m){
  ui.mode = m;
  if(m==='viewer'){
    toolbar.querySelectorAll('button').forEach(b=>{ if(b.id!=='modeToggle') b.classList.add('hidden') });
    sidebar.classList.add('hidden');
    modeToggle.textContent = 'Switch to Editor';
    // hide keyframe visuals in viewer/playback mode
    if(map.hasLayer(keyframeLayer)) map.removeLayer(keyframeLayer);
    // lock map interactions for viewer mode (we still allow pan/zoom)
  } else {
    toolbar.querySelectorAll('button').forEach(b=> b.classList.remove('hidden'));
    sidebar.classList.remove('hidden');
    modeToggle.textContent = 'Switch to Viewer';
    // ensure keyframe visuals are visible in editor
    if(!map.hasLayer(keyframeLayer)) map.addLayer(keyframeLayer);
  }
}

modeToggle.addEventListener('click', ()=> setMode(ui.mode==='editor'?'viewer':'editor'));

// Helper to move an animation entry by direction (-1 = up, +1 = down)
function moveAnimationById(id, direction){
  const idx = ui.animations.findIndex(a=>a.id === id);
  if(idx < 0) return;
  const newIdx = idx + direction;
  if(newIdx < 0 || newIdx >= ui.animations.length) return;
  const tmp = ui.animations[idx];
  ui.animations[idx] = ui.animations[newIdx];
  ui.animations[newIdx] = tmp;
  refreshAnimList();
}

function addAnimationEntry(anim){
  const li = document.createElement('li');
  // textual label
  const label = document.createElement('span');
  label.textContent = `${anim.type} ${anim.id}`;
  label.style.flex = '1';
  li.appendChild(label);

  // Play button: look up the current object by id at playback time
  const playBtn = document.createElement('button'); playBtn.textContent='Play';
  playBtn.addEventListener('click', ()=> {
    const current = ui.animations.find(a => a.id === anim.id);
    if(current) playAnimation(current);
    else playAnimation(anim); // fallback
  });

  // Up / Down reorder buttons
  const upBtn = document.createElement('button'); upBtn.textContent='↑';
  upBtn.title = 'Move up';
  upBtn.addEventListener('click', ()=> moveAnimationById(anim.id, -1));
  const downBtn = document.createElement('button'); downBtn.textContent='↓';
  downBtn.title = 'Move down';
  downBtn.addEventListener('click', ()=> moveAnimationById(anim.id, +1));

  // Delete button: remove from ui.animations, remove visual markers for that id, persist
  const delBtn = document.createElement('button'); delBtn.textContent='Delete';
  delBtn.addEventListener('click', ()=>{
    ui.animations = ui.animations.filter(a=>a.id!==anim.id);
    // remove any layers in animationLayer or keyframeLayer that were created with this anim id
    animationLayer.eachLayer(l => { if(l._animId === anim.id) animationLayer.removeLayer(l); });
    keyframeLayer.eachLayer(l => { if(l._animId === anim.id) keyframeLayer.removeLayer(l); });
    li.remove();
    try{ saveAnimationsToStorage(); }catch(e){}
  });

  li.appendChild(playBtn);
  li.appendChild(upBtn);
  li.appendChild(downBtn);
  li.appendChild(delBtn);
  animList.appendChild(li);

  // persist immediately whenever we add a single entry
  try{ saveAnimationsToStorage(); }catch(e){}
}

function refreshAnimList(){
  animList.innerHTML = '';
  for(const a of ui.animations) addAnimationEntry(a);
  saveAnimationsToStorage();
}

function capturePoints(promptText, options={multiple:false}){
  return new Promise((resolve,reject)=>{
    overlayText.textContent = promptText;
    overlayInputs.innerHTML = '';
    overlay.classList.remove('hidden');
    overlayStop.classList.toggle('hidden', !options.multiple);

    const points = [];

    function onMapClick(e){
      const lnglat = [e.latlng.lng, e.latlng.lat];
      points.push(lnglat);
      const p = document.createElement('div'); p.textContent = `Point ${points.length}: ${lnglat[1].toFixed(6)}, ${lnglat[0].toFixed(6)}`;
      overlayInputs.appendChild(p);
      if(!options.multiple){
        finish();
      }
    }

    function finish(){
      map.off('click', onMapClick);
      overlay.classList.add('hidden');
      overlayInputs.innerHTML='';
      overlayStop.classList.add('hidden');
      overlayCancel.removeEventListener('click', cancel);
      overlayStop.removeEventListener('click', stopCapturing);
      resolve(points);
    }

    function cancel(){
      map.off('click', onMapClick);
      overlay.classList.add('hidden');
      overlayInputs.innerHTML='';
      overlayStop.classList.add('hidden');
      overlayCancel.removeEventListener('click', cancel);
      overlayStop.removeEventListener('click', stopCapturing);
      reject(new Error('cancelled'));
    }

    function stopCapturing(){ finish(); }

    overlayCancel.addEventListener('click', cancel);
    overlayStop.addEventListener('click', stopCapturing);
    map.on('click', onMapClick);
  });
}

// toolbar button wiring
document.getElementById('btnCircle').addEventListener('click', async ()=>{
  try{
    const pts = await capturePoints('Click the centre for the circle (single click)');
    if(!pts || pts.length===0) return;
    const radiusStr = prompt('Radius in meters', '500');
    const color = prompt('fill color after 5s (green, red, gold or purple)', 'gold');
    const id = `anim-${Date.now()}`;
    ui.animations.push({type:'circle', id, params:{centre:pts[0], radius:parseFloat(radiusStr||500), color}});
    addAnimationEntry(ui.animations[ui.animations.length-1]);
  }catch(e){}
});

document.getElementById('btnSplit').addEventListener('click', async ()=>{
  try{
    const pts = await capturePoints('Click point A then point B to define the split (two clicks)', {multiple:true});
    if(!pts || pts.length<2) return;
    const side = prompt('Which side to shade after 5s? (A or B)', 'A');
    const color = prompt('Shade colour (name or hex)', side==='A' ? '#e74c3c' : '#2ecc71');
    const id = `anim-${Date.now()}`;
    ui.animations.push({type:'split', id, params:{a:pts[0], b:pts[1], side, color}});
    addAnimationEntry(ui.animations[ui.animations.length-1]);
  }catch(e){}
});

document.getElementById('btnRoute').addEventListener('click', async ()=>{
  try{
    const pts = await capturePoints('Click route waypoints; press Stop when finished', {multiple:true});
    if(!pts || pts.length<2) return;
    const speed = prompt('Speed meters/second (approx)', '500');
    const color = prompt('route color (yellow or purple)', 'yellow');
    const id = `anim-${Date.now()}`;
    ui.animations.push({type:'route', id, params:{points:pts, speed:parseFloat(speed||120), color}});
    addAnimationEntry(ui.animations[ui.animations.length-1]);
  }catch(e){}
});

// Keyframe button: capture current map view immediately
document.getElementById('btnKeyframe').addEventListener('click', ()=>{
  try{
    const k = placeKeyframe();
    ui.animations.push({type:'keyframe', id: k.id, params:{center: k.center, zoom: k.zoom}});
    addAnimationEntry(ui.animations[ui.animations.length-1]);
  }catch(e){ console.warn('Keyframe add cancelled', e); }
});

document.getElementById('btnPolygon').addEventListener('click', async ()=>{
  try{
    // capture multiple points until user clicks Stop in the overlay
    const pts = await capturePoints('Click polygon vertices; press Stop when finished', {multiple:true});
    if(!pts || pts.length<3){ alert('Need at least 3 points to make a polygon'); return; }
    const color = prompt('Polygon fill colour (name or hex)', 'purple');
    const id = `polygon-${Date.now()}`;
    ui.animations.push({type:'polygon', id, params:{points: pts, color}});
    addAnimationEntry(ui.animations[ui.animations.length-1]);
  }catch(e){ /* cancelled */ }
});

document.getElementById('btnDropMarker').addEventListener('click', async ()=>{

  try{
    const pts = await capturePoints('Click the map to place a marker (single click)');
    if(!pts || pts.length===0) return;
    const color = document.getElementById('markerColor') ? document.getElementById('markerColor').value : '#ff0000';
    const id = `marker-${Date.now()}`;
    dropMarker(pts[0], color, {id});
    ui.animations.push({type:'marker', id, params:{point:pts[0], color}});
    addAnimationEntry(ui.animations[ui.animations.length-1]);
  }catch(e){}
});

document.getElementById('btnClear').addEventListener('click', ()=>{
  if(!confirm('Clear all animations?')) return;
  ui.animations = [];
  animList.innerHTML = '';
  // remove visual artifacts from the map
  animationLayer.clearLayers();
  saveAnimationsToStorage();
});

document.getElementById('btnPlayAll').addEventListener('click', async ()=>{
  // Clear any previous playback drawings so we start fresh
  animationLayer.clearLayers();
  // Ensure keyframe visuals are hidden while playing
  if(map.hasLayer(keyframeLayer)) map.removeLayer(keyframeLayer);
  setMode('viewer');

  for(const a of ui.animations){
    await playAnimation(a);
    await new Promise(r=>setTimeout(r,500));
  }

  // restore editor UI and keyframe visuals
  setMode('editor');
  if(!map.hasLayer(keyframeLayer)) map.addLayer(keyframeLayer);
});

// ------------------
// Import / Export
// ------------------
const STORAGE_KEY = 'map_animations_v1';

function saveAnimationsToStorage(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ui.animations));
  }catch(e){ console.warn('Could not save', e); }
}

function loadAnimationsFromStorage(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return;
    const arr = JSON.parse(raw);
    if(Array.isArray(arr)){
      ui.animations = arr;
      refreshAnimList();
    }
  }catch(e){ console.warn('Could not load animations', e); }
}

document.getElementById('btnExport').addEventListener('click', ()=>{
  const dataStr = JSON.stringify(ui.animations, null, 2);
  const blob = new Blob([dataStr], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'animations.json'; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

const fileInput = document.getElementById('fileInput');
document.getElementById('btnImport').addEventListener('click', ()=> fileInput.click());
fileInput.addEventListener('change', async (ev)=>{
  const f = ev.target.files && ev.target.files[0];
  if(!f) return;
  try{
    const text = await f.text();
    const parsed = JSON.parse(text);
    if(!Array.isArray(parsed)) throw new Error('Invalid file');
    ui.animations = parsed;
    refreshAnimList();
    alert('Imported '+parsed.length+' animations');
  }catch(e){ alert('Import failed: '+e.message); }
  fileInput.value = '';
});

// autosave when animations change: wrap push operations to call refresh
const originalPush = Array.prototype.push;

// Instead of monkeypatching everywhere, ensure we call save after adding animations in button handlers.

// load on startup
loadAnimationsFromStorage();

// play a single animation and control map view during playback
async function playAnimation(a){
  if(a.type==='circle'){
    // ensure centre is [lon,lat]
    function normalizeCoord(pt){ if(!pt || pt.length<2) return pt; const x=Number(pt[0]), y=Number(pt[1]); if(Math.abs(x)<=90 && Math.abs(y)>90) return [y,x]; return [x,y]; }
    const centre = normalizeCoord(a.params.centre);
    const radiusMeters = Number(a.params.radius) || 500;
    // add a small buffer so the circle isn't clipped (12% or minimum 200m)
    const bufferMeters = Math.max(200, Math.round(radiusMeters * 0.12));
    const extentKm = (radiusMeters + bufferMeters) / 1000;
    const pt = turf.point(centre);
    // compute cardinal points at distance (radius + buffer)
    const north = turf.destination(pt, extentKm, 0, {units:'kilometers'}).geometry.coordinates;
    const east  = turf.destination(pt, extentKm, 90, {units:'kilometers'}).geometry.coordinates;
    const south = turf.destination(pt, extentKm, 180, {units:'kilometers'}).geometry.coordinates;
    const west  = turf.destination(pt, extentKm, 270, {units:'kilometers'}).geometry.coordinates;
    const lons = [north[0], east[0], south[0], west[0]];
    const lats = [north[1], east[1], south[1], west[1]];
    const minLon = Math.min(...lons), maxLon = Math.max(...lons);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const bounds = L.latLngBounds([L.latLng(minLat, minLon), L.latLng(maxLat, maxLon)]);
    // fit bounds (with pixel padding) so full circle is visible
    map.fitBounds(bounds, {duration: FLY_DURATION, padding: [40,40]});
    // wait for the fitBounds transition to finish before drawing the circle
    await new Promise(resolve => map.once('moveend', resolve));
    drawCircle(centre, radiusMeters, a.params.color, {id: a.id});
    await new Promise(r=>setTimeout(r,6000));
  } else if(a.type==='split'){
    // center between points (normalize input to ensure [lon,lat])
    function normalizeCoord(pt){
      if(!pt || pt.length<2) return pt;
      const x = Number(pt[0]), y = Number(pt[1]);
      if(Math.abs(x) <= 90 && Math.abs(y) > 90) return [y, x];
      return [x,y];
    }
    const pa = normalizeCoord(a.params.a);
    const pb = normalizeCoord(a.params.b);
    const mid = [(pa[0]+pb[0])/2, (pa[1]+pb[1])/2];
    map.flyTo(toLatLng(mid), 15, {duration: FLY_DURATION});
    // wait for movement to finish before drawing split
    await new Promise(resolve => map.once('moveend', resolve));
    splitMap(pa, pb, a.params.side, {color: a.params.color});
    await new Promise(r=>setTimeout(r,6000));
  } else if(a.type==='route'){
    // fit bounds
    const latlngs = a.params.points.map(p=>toLatLng(p));
    const bounds = L.latLngBounds(latlngs);
    map.fitBounds(bounds.pad ? bounds.pad(0.2) : bounds, {duration: FLY_DURATION});
    // wait for fitBounds transition to finish before drawing the route
    await new Promise(resolve => map.once('moveend', resolve));
    await drawRoute(a.params.points, a.params.speed, {color: a.params.color});
  } else if(a.type==='polygon'){
    // Draw polygon outline immediately, then fill after 5s. Do NOT move the map.
    drawPolygon(a.params.points, a.params.color, {id: a.id});
    // wait slightly longer than fill delay so playback sequencing preserves timing
    await new Promise(r=>setTimeout(r,6000));
  } else if(a.type==='marker'){
    // show marker and zoom in briefly
    map.flyTo(toLatLng(a.params.point), 16, {duration: FLY_DURATION});
    // wait until the map has finished moving before placing the marker
    await new Promise(resolve => map.once('moveend', resolve));
    dropMarker(a.params.point, a.params.color);
    await new Promise(r=>setTimeout(r,500));
    } else if(a.type==='keyframe'){
      // fly to stored center and zoom
      const c = a.params.center;
      const z = a.params.zoom != null ? a.params.zoom : map.getZoom();
      try{
        map.flyTo(toLatLng(c), z, {duration: FLY_DURATION});
        // wait for the transition to finish so subsequent animations start after movement
        await new Promise(resolve => map.once('moveend', resolve));
      }catch(e){
        // fallback if center malformed
        console.warn('Invalid keyframe center', e);
        map.setZoom(z);
      }
      // small pause so user can see keyframe
      await new Promise(r=>setTimeout(r,800));
  }
}

// initialize UI visibility
setMode('editor');

