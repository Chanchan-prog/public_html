import { apiUrl } from '../services/api.js';

// QR payload generation and downloaded image content are intentionally kept unchanged.
function QrModal({ show, onClose, token, manualCode, active, floorName = 'Floor', buildingName = '', readOnly = false, onRegenerateManualCode, regeneratingManualCode = false }) {
  const canvasRef = React.useRef(null);
  const [qrAvailable, setQrAvailable] = React.useState(false);
  const [imageUrl, setImageUrl] = React.useState('');

  React.useEffect(() => {
    if (!show || !token) return;
    let cancelled = false;
    (async () => {
      try {
        // Prefer global QRCode (loaded via CDN script tag)
        let QR = (typeof window !== 'undefined' && window.QRCode) ? window.QRCode : null;
        if (!QR) {
          // Try virtual module 'qrcode' handled by the in-browser loader
          try { const mod = await import('qrcode'); QR = mod && (mod.default || mod); } catch (e) { QR = null; }
        }

        if (cancelled) return;

        if (QR && canvasRef.current) {
          try {
            if (typeof QR.toCanvas === 'function') {
              await QR.toCanvas(canvasRef.current, token, { width: 240 });
              setQrAvailable(true);
              setImageUrl('');
              return;
            }
            if (typeof QR === 'function') {
              try { QR(canvasRef.current, token); setQrAvailable(true); setImageUrl(''); return; } catch(e){}
            }
          } catch (e) {
            console.error('QrModal: QR generation failed', e);
          }
        }

        // Fallback: use the same centralized API base as every other request.
        setImageUrl(apiUrl('qrcode?data=' + encodeURIComponent(token)));
        setQrAvailable(false);
      } catch (err) {
        console.error('QrModal error', err);
        const proxyUrl = apiUrl('qrcode?data=' + encodeURIComponent(token));
        setImageUrl(proxyUrl);
        setQrAvailable(false);
      }
    })();
    return () => { cancelled = true; };
  }, [show, token]);

  const download = async () => {
    try {
      const output = document.createElement('canvas');
      output.width = 280;
      output.height = manualCode ? 320 : 280;
      const ctx = output.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, output.width, output.height);

      let source = null;
      if (qrAvailable && canvasRef.current) {
        source = canvasRef.current;
      } else if (imageUrl) {
        const res = await fetch(imageUrl, { mode: 'cors' });
        if (!res.ok) throw new Error('Failed to fetch QR image');
        const blob = await res.blob();
        source = await new Promise((resolve, reject) => {
          const objectUrl = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => { URL.revokeObjectURL(objectUrl); resolve(img); };
          img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Failed to read QR image')); };
          img.src = objectUrl;
        });
      }
      if (!source) throw new Error('QR image is not ready');

      ctx.drawImage(source, 20, 20, 240, 240);
      if (manualCode) {
        ctx.fillStyle = '#111827';
        ctx.font = '700 24px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(manualCode).toUpperCase(), output.width / 2, 292);
      }

      const url = output.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = `qr_${manualCode || token}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      console.error('QrModal download failed', e);
      if (imageUrl) window.open(imageUrl, '_blank');
    }
  };

  if (!show) return null;
  return (
    <div className="fixed inset-0 z-[1200] flex items-start justify-center overflow-y-auto bg-slate-950/65 p-3 backdrop-blur-sm sm:p-6" onClick={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div className="my-auto w-full max-w-md overflow-hidden rounded-2xl border border-white/20 bg-white shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="floor-qr-title">
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 bg-gradient-to-br from-emerald-50 to-white px-4 py-4 sm:px-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-700 text-xl text-white shadow-sm" aria-hidden="true"><i className="bi bi-qr-code" /></span>
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-700">Floor access</p>
              <h2 id="floor-qr-title" className="truncate text-lg font-bold text-slate-900">{floorName || 'Floor QR Code'}</h2>
              <p className="truncate text-xs text-slate-500">{buildingName || 'Campus building'} · Ready to preview and download</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-800" aria-label="Close QR preview"><i className="bi bi-x-lg" /></button>
        </header>

        <div className="bg-slate-50 px-4 py-5 text-center sm:px-6">
          <div className="mx-auto w-fit rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
            <canvas ref={canvasRef} style={{display:qrAvailable ? 'block' : 'none',margin:'0 auto'}} />
            {!qrAvailable && (imageUrl
              ? <img src={imageUrl} alt="QR code" width={240} height={240} style={{display:'block',margin:'0 auto'}} />
              : <div className="flex h-60 w-60 items-center justify-center px-5 text-sm text-slate-500">QR library not loaded — cannot render QR.</div>)}
          </div>

          {manualCode && (
            <div style={{marginTop:10,fontSize:22,fontWeight:800,letterSpacing:'0.12em',color:'#111827'}}>
              {String(manualCode).toUpperCase()}
            </div>
          )}

          <div className={`mx-auto mt-4 flex max-w-sm items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left text-xs ${active ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
            <i className={`bi ${active ? 'bi-check-circle-fill' : 'bi-info-circle-fill'} mt-0.5 shrink-0`} aria-hidden="true" />
            <span>{active ? 'Active floor: this QR is currently enabled for floor verification.' : 'Inactive floor: you can download this QR, but scanning remains disabled until an Admin activates the floor.'}</span>
          </div>
          {readOnly ? <p className="mt-3 text-[11px] text-slate-500"><i className="bi bi-eye mr-1" />View and download access only</p> : null}
        </div>

        <footer className="flex flex-col-reverse gap-2 border-t border-slate-200 bg-white px-4 py-4 sm:flex-row sm:justify-end sm:px-5">
          <button type="button" onClick={onClose} className="inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">Close</button>
          {onRegenerateManualCode && (
            <button type="button" onClick={onRegenerateManualCode} disabled={regeneratingManualCode || !active} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 text-sm font-semibold text-amber-800 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50">
              <i className="bi bi-arrow-repeat" />{regeneratingManualCode ? 'Regenerating...' : 'Regenerate Manual Code'}
            </button>
          )}
          <button type="button" onClick={download} disabled={!token} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-700 px-5 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-400"><i className="bi bi-download" />Download QR</button>
        </footer>
      </div>
    </div>
  );
}

export default QrModal;
