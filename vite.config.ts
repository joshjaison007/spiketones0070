import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

function driveVideoPlugin() {
  return {
    name: 'drive-video-streamer',
    configureServer(server: any) {
      server.middlewares.use('/api/drive-video', async (req: any, res: any) => {
        const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost:3000'}`);
        const id = urlObj.searchParams.get('id');
        if (!id) {
          res.statusCode = 400;
          return res.end('Missing Google Drive id parameter');
        }

        try {
          // Direct download link with confirm=t to bypass virus scan interstitial
          const targetUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
          const fetchHeaders: Record<string, string> = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
          };
          if (req.headers.range) {
            fetchHeaders['Range'] = req.headers.range;
          }

          const driveRes = await fetch(targetUrl, {
            headers: fetchHeaders,
            redirect: 'follow'
          });

          res.statusCode = driveRes.status;
          const ct = driveRes.headers.get('content-type') || 'video/mp4';
          res.setHeader('Content-Type', ct.includes('html') ? 'video/mp4' : ct);
          
          const cl = driveRes.headers.get('content-length');
          if (cl) res.setHeader('Content-Length', cl);

          const cr = driveRes.headers.get('content-range');
          if (cr) res.setHeader('Content-Range', cr);

          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Access-Control-Allow-Origin', '*');

          if (driveRes.body) {
            // @ts-ignore
            const reader = driveRes.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(Buffer.from(value));
            }
            res.end();
          } else {
            res.end();
          }
        } catch (err: any) {
          console.error('Error streaming Google Drive video:', err);
          res.statusCode = 502;
          res.end('Error streaming Google Drive video');
        }
      });
    }
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), driveVideoPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      proxy: {
        '/api/leetify': {
          target: 'https://api-public.cs-prod.leetify.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/leetify/, ''),
          headers: {
            '_leetify_key': process.env.LEETIFY_API_KEY || 'cc554ec3-3db6-4f54-83b2-c070c40da483',
            'Authorization': `Bearer ${process.env.LEETIFY_API_KEY || 'cc554ec3-3db6-4f54-83b2-c070c40da483'}`
          }
        }
      }
    },
  };
});
