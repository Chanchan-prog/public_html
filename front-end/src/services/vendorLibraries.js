// Load pinned CDN vendors only when a page needs them. Local copies remain as
// automatic fallbacks so a CDN/network problem does not disable the feature.
const pending = new Map();

const CDN_URLS = Object.freeze({
  'xlsx/xlsx.full.min.js': 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'html2pdf/html2pdf.bundle.min.js': 'https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.1/dist/html2pdf.bundle.min.js',
  'd3/d3.v7.min.js': 'https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js',
  'html5-qrcode/html5-qrcode.min.js': 'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js',
  'three/three.min.js': 'https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js',
  'three/OrbitControls.js': 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js',
  'three/GLTFLoader.js': 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js',
  'three/OBJLoader.js': 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/OBJLoader.js',
  'three/STLLoader.js': 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/STLLoader.js',
  'fflate/fflate.min.js': 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js',
  'three/NURBSUtils.js': 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/curves/NURBSUtils.js',
  'three/NURBSCurve.js': 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/curves/NURBSCurve.js',
  'three/FBXLoader.js': 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/FBXLoader.js',
});

function localVendorUrl(file) {
  const url = new URL('vendor/' + file, document.baseURI || window.location.href);
  const version = window.APP_ASSET_VERSIONS?.[url.pathname];
  if (version) url.searchParams.set('v', version);
  return url.href;
}

function appendScript(url, ready, isCdn) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      if (error) { script.remove(); reject(error); }
      else resolve();
    };
    const timer = window.setTimeout(
      () => finish(new Error('Page resources took too long to load. Please try again.')),
      15000,
    );
    script.src = url;
    script.async = true;
    if (isCdn) script.crossOrigin = 'anonymous';
    script.onload = () => finish(ready() ? null : new Error('A required page resource could not start. Please try again.'));
    script.onerror = () => finish(new Error('Unable to download page resources. Check your connection and try again.'));
    document.head.appendChild(script);
  });
}

function loadScript(file, ready) {
  if (ready()) return Promise.resolve();
  if (pending.has(file)) return pending.get(file);
  const cdnUrl = CDN_URLS[file];
  const promise = (cdnUrl ? appendScript(cdnUrl, ready, true) : Promise.reject(new Error('CDN URL is not configured.')))
    .catch((cdnError) => {
      console.warn(`[vendor] CDN unavailable for ${file}; using the local copy.`, cdnError);
      return appendScript(localVendorUrl(file), ready, false);
    });
  pending.set(file, promise);
  promise.catch(() => { if (pending.get(file) === promise) pending.delete(file); });
  return promise;
}

export async function ensureVendorLibrary(name) {
  switch (name) {
    case 'spreadsheet':
      return loadScript('xlsx/xlsx.full.min.js', () => Boolean(window.XLSX));
    case 'pdf':
      return loadScript('html2pdf/html2pdf.bundle.min.js', () => typeof window.html2pdf === 'function');
    case 'charts':
      return loadScript('d3/d3.v7.min.js', () => Boolean(window.d3));
    case 'scanner':
      return loadScript('html5-qrcode/html5-qrcode.min.js', () => Boolean(window.Html5Qrcode));
    case 'three':
      await loadScript('three/three.min.js', () => Boolean(window.THREE));
      await Promise.all([
        loadScript('three/OrbitControls.js', () => Boolean(window.THREE.OrbitControls)),
        loadScript('three/GLTFLoader.js', () => Boolean(window.THREE.GLTFLoader)),
        loadScript('three/OBJLoader.js', () => Boolean(window.THREE.OBJLoader)),
        loadScript('three/STLLoader.js', () => Boolean(window.THREE.STLLoader)),
        loadScript('fflate/fflate.min.js', () => Boolean(window.fflate)),
        loadScript('three/NURBSUtils.js', () => Boolean(window.THREE.NURBSUtils)),
      ]);
      await loadScript('three/NURBSCurve.js', () => Boolean(window.THREE.NURBSCurve));
      await loadScript('three/FBXLoader.js', () => Boolean(window.THREE.FBXLoader));
      return;
    default:
      throw new Error('Unknown page resource group.');
  }
}

export function ensureVendorLibraries(names) {
  return Promise.all(names.map(ensureVendorLibrary));
}
