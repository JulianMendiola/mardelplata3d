// Descarga datos reales de Mar del Plata desde Overpass (OpenStreetMap)
// y los guarda crudos en scripts/raw/ para que build-data.mjs los procese.
import { writeFile, mkdir } from 'node:fs/promises';

const BBOX = '-38.105,-57.63,-37.935,-57.50'; // sur, oeste, norte, este
const API = 'https://overpass-api.de/api/interpreter';
const UA = 'mardelplata3d/1.0 (https://github.com/JulianMendiola/mardelplata3d)';

const QUERIES = {
  roads_major: `way["highway"~"^(motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link)$"](${BBOX});`,
  roads_minor: `way["highway"~"^(residential|unclassified|living_street|pedestrian|service)$"]["service"!~"."](${BBOX});`,
  buildings: `way["building"](${BBOX});`,
  coastline: `way["natural"="coastline"](${BBOX});`,
  beaches: `way["natural"="beach"](${BBOX});`,
  green: `(way["leisure"~"^(park|garden|golf_course)$"](${BBOX});way["landuse"~"^(grass|forest|recreation_ground)$"](${BBOX}););`,
  water: `way["natural"="water"](${BBOX});`,
  rail: `way["railway"="rail"](${BBOX});`,
  piers: `way["man_made"~"^(groyne|pier|breakwater)$"](${BBOX});`,
};

async function fetchQuery(name, body) {
  const query = `[out:json][timeout:180];${body}out geom;`;
  console.log(`-> ${name} ...`);
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  await writeFile(new URL(`./raw/${name}.json`, import.meta.url), JSON.stringify(json));
  console.log(`   ${name}: ${json.elements.length} elementos`);
  // pausa de cortesía entre consultas
  await new Promise(r => setTimeout(r, 3000));
}

await mkdir(new URL('./raw/', import.meta.url), { recursive: true });
const only = process.argv.slice(2);
for (const [name, body] of Object.entries(QUERIES)) {
  if (only.length && !only.includes(name)) continue;
  await fetchQuery(name, body);
}
console.log('listo.');
