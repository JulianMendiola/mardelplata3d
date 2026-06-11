// Convierte los JSON crudos de OSM en binarios compactos para el visor:
//  - líneas (calles, rieles, escolleras) como pares de segmentos Float32 [x1,z1,x2,z2,...]
//  - polígonos (tierra, playas, verde, agua) triangulados con earcut [x,z por vértice]
//  - edificios extruidos (techo + paredes) como soup de triángulos 3D [x,y,z]
//  - meta.json con landmarks, rutas para autos y tamaños
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import earcut from 'earcut';

const LAT0 = -38.005, LON0 = -57.5426;
const MX = 111320 * Math.cos(LAT0 * Math.PI / 180); // metros por grado de longitud
const MZ = 110574;                                   // metros por grado de latitud
const px = lon => (lon - LON0) * MX;
const pz = lat => (LAT0 - lat) * MZ;

const raw = async name =>
  JSON.parse(await readFile(new URL(`./raw/${name}.json`, import.meta.url), 'utf8'));

await mkdir(new URL('../data/', import.meta.url), { recursive: true });
const out = async (name, f32) => {
  await writeFile(new URL(`../data/${name}.bin`, import.meta.url), Buffer.from(f32.buffer));
  console.log(`${name}.bin: ${(f32.byteLength / 1048576).toFixed(2)} MB`);
};

/* ---------- líneas ---------- */
function toSegments(elements) {
  const segs = [];
  for (const w of elements) {
    if (!w.geometry) continue;
    for (let i = 0; i < w.geometry.length - 1; i++) {
      segs.push(px(w.geometry[i].lon), pz(w.geometry[i].lat),
                px(w.geometry[i + 1].lon), pz(w.geometry[i + 1].lat));
    }
  }
  return new Float32Array(segs);
}

const roadsMajor = await raw('roads_major');
const roadsMinor = await raw('roads_minor');
await out('roads_major', toSegments(roadsMajor.elements));
await out('roads_minor', toSegments(roadsMinor.elements));
await out('rail', toSegments((await raw('rail')).elements));
await out('piers', toSegments((await raw('piers')).elements));

/* ---------- polígonos planos ---------- */
function closedRings(elements, minPts = 4) {
  const rings = [];
  for (const w of elements) {
    if (!w.geometry || w.geometry.length < minPts) continue;
    const g = w.geometry;
    const closed = g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;
    if (!closed) continue;
    rings.push(g.slice(0, -1).map(p => [px(p.lon), pz(p.lat)]));
  }
  return rings;
}

function triangulateRings(rings) {
  const tris = [];
  for (const ring of rings) {
    const flat = ring.flat();
    const idx = earcut(flat);
    for (const i of idx) tris.push(flat[i * 2], flat[i * 2 + 1]);
  }
  return new Float32Array(tris);
}

await out('beaches', triangulateRings(closedRings((await raw('beaches')).elements)));
await out('green', triangulateRings(closedRings((await raw('green')).elements)));
await out('water', triangulateRings(closedRings((await raw('water')).elements)));

/* ---------- tierra (a partir de la línea de costa) ---------- */
{
  const ways = (await raw('coastline')).elements.filter(w => w.geometry);
  // unir tramos por extremos coincidentes
  const chains = ways.map(w => w.geometry.map(p => [px(p.lon), pz(p.lat)]));
  const EPS = 1;
  let merged = chains.shift();
  while (chains.length) {
    let used = false;
    for (let i = 0; i < chains.length; i++) {
      const c = chains[i];
      const close = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < EPS;
      if (close(merged[merged.length - 1], c[0])) { merged = merged.concat(c.slice(1)); chains.splice(i, 1); used = true; break; }
      if (close(merged[merged.length - 1], c[c.length - 1])) { merged = merged.concat(c.reverse().slice(1)); chains.splice(i, 1); used = true; break; }
      if (close(merged[0], c[c.length - 1])) { merged = c.concat(merged.slice(1)); chains.splice(i, 1); used = true; break; }
      if (close(merged[0], c[0])) { merged = c.reverse().concat(merged.slice(1)); chains.splice(i, 1); used = true; break; }
    }
    if (!used) { console.warn('tramo de costa sin unir:', chains.length); break; }
  }
  // orientar de norte (z menor) a sur (z mayor)
  if (merged[0][1] > merged[merged.length - 1][1]) merged.reverse();
  const minX = px(-57.63) - 800, minZ = pz(-37.935) - 800, maxZ = pz(-38.105) + 800;
  const poly = [[merged[0][0], minZ], ...merged, [merged[merged.length - 1][0], maxZ],
                [minX, maxZ], [minX, minZ]];
  await out('land', triangulateRings([poly]));
  // la costa también como línea (para dibujar el borde)
  await out('coast', new Float32Array(merged.flat()));
}

/* ---------- edificios extruidos ---------- */
const LANDMARK_CLEAR = [ // [x, z, radio]: no extruir OSM donde van los modelos propios
  [px(-57.54189), pz(-38.00422), 70],  // Casino
  [px(-57.54111), pz(-38.00634), 60],  // Hotel Provincial
  [px(-57.53333), pz(-38.00801), 45],  // Torreón
  [px(-57.53517), pz(-38.01315), 30],  // Torre Tanque
  [px(-57.54898), pz(-37.99900), 60],  // Catedral
  [px(-57.54492), pz(-38.09171), 40],  // Faro
];
{
  const elements = (await raw('buildings')).elements;
  const tris = [];
  const hash = id => { let h = id >>> 0; h = (h ^ 61) ^ (h >>> 16); h = h + (h << 3); h ^= h >>> 4; h = Math.imul(h, 0x27d4eb2d); h ^= h >>> 15; return (h >>> 0) / 4294967295; };
  let count = 0;
  for (const w of elements) {
    if (!w.geometry || w.geometry.length < 4) continue;
    const g = w.geometry;
    if (g[0].lat !== g[g.length - 1].lat || g[0].lon !== g[g.length - 1].lon) continue;
    const ring = g.slice(0, -1).map(p => [px(p.lon), pz(p.lat)]);
    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const cz = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    if (LANDMARK_CLEAR.some(([lx, lz, r]) => Math.hypot(cx - lx, cz - lz) < r)) continue;
    const t = w.tags || {};
    let h = parseFloat(t.height) || (parseFloat(t['building:levels']) * 3.1) || 0;
    if (!h) {
      // alturas estimadas: torres sobre la costa céntrica, microcentro medio, resto bajo
      const r = hash(w.id);
      const dCasino = Math.hypot(cx - px(-57.54189), cz - pz(-38.00422));
      // distancia aproximada a la costa céntrica (anclas conocidas)
      const dCoast = Math.min(
        Math.hypot(cx - px(-57.54009), cz - pz(-38.00417)),   // Bristol
        Math.hypot(cx - px(-57.53333), cz - pz(-38.00801)),   // Torreón
        Math.hypot(cx - px(-57.5462), cz - pz(-37.9930)),     // costa norte (La Perla)
        Math.hypot(cx - px(-57.5310), cz - pz(-38.0190)),     // Varese
      );
      if (dCoast < 600 && r > 0.45) h = 25 + r * 75;          // torres frente al mar
      else if (dCasino < 1600 && r > 0.6) h = 12 + r * 35;    // microcentro
      else h = 4 + r * 8;
    }
    h = Math.min(h, 160);
    const flat = ring.flat();
    // techo
    for (const i of earcut(flat)) tris.push(flat[i * 2], h, flat[i * 2 + 1]);
    // paredes
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
      tris.push(ax, 0, az, bx, 0, bz, bx, h, bz);
      tris.push(ax, 0, az, bx, h, bz, ax, h, az);
    }
    count++;
  }
  await out('buildings', new Float32Array(tris));
  console.log(`edificios extruidos: ${count}`);
}

/* ---------- rutas para autos (avenidas largas) ---------- */
const carPaths = roadsMajor.elements
  .filter(w => w.geometry && w.geometry.length >= 8)
  .map(w => w.geometry.map(p => [px(p.lon), pz(p.lat)]))
  .map(pts => ({ pts, len: pts.reduce((s, p, i) => i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0, 0) }))
  .sort((a, b) => b.len - a.len)
  .slice(0, 50)
  .map(p => p.pts.map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]));

/* ---------- meta ---------- */
const meta = {
  attribution: 'Datos del mapa © OpenStreetMap contributors (ODbL)',
  landmarks: [
    { id: 'casino',   name: 'Casino Central',        x: px(-57.54189), z: pz(-38.00422), wiki: 'Casino_de_Mar_del_Plata' },
    { id: 'provincial', name: 'Hotel Provincial',    x: px(-57.54111), z: pz(-38.00634), wiki: 'Gran_Hotel_Provincial' },
    { id: 'lobos',    name: 'Lobos Marinos',         x: px(-57.54124), z: pz(-38.00485), wiki: 'Mar_del_Plata' },
    { id: 'bristol',  name: 'Playa Bristol',         x: px(-57.54009), z: pz(-38.00417), wiki: 'Playa_Bristol' },
    { id: 'torreon',  name: 'Torreón del Monje',     x: px(-57.53333), z: pz(-38.00801), wiki: 'Torreón_del_Monje' },
    { id: 'tanque',   name: 'Torre Tanque',          x: px(-57.53517), z: pz(-38.01315), wiki: 'Torre_Tanque' },
    { id: 'catedral', name: 'Catedral',              x: px(-57.54898), z: pz(-37.99900), wiki: 'Catedral_de_los_Santos_Pedro_y_Cecilia' },
    { id: 'puerto',   name: 'Puerto y lobería',      x: px(-57.52730), z: pz(-38.04386), wiki: 'Puerto_de_Mar_del_Plata' },
    { id: 'faro',     name: 'Faro Punta Mogotes',    x: px(-57.54492), z: pz(-38.09171), wiki: 'Faro_de_Punta_Mogotes' },
  ],
  escolleraNorte: { x: px(-57.52662), z: pz(-38.03461) },
  carPaths,
};
await writeFile(new URL('../data/meta.json', import.meta.url), JSON.stringify(meta));
console.log('meta.json listo —', meta.landmarks.length, 'landmarks,', carPaths.length, 'rutas');
