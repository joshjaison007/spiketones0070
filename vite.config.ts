import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { defineConfig, Plugin } from 'vite';

function extractDriveId(urlStr: string): string | null {
  if (!urlStr) return null;
  const fileDMatch = urlStr.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileDMatch) return fileDMatch[1];
  const idMatch = urlStr.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idMatch) return idMatch[1];
  if (/^[a-zA-Z0-9_-]{25,}$/.test(urlStr.trim())) return urlStr.trim();
  return null;
}

function videoStreamPlugin(): Plugin {
  return {
    name: 'video-stream-plugin',
    configureServer(server) {
      server.middlewares.use('/api/video-stream', (req: any, res: any) => {
        try {
          const reqUrl = new URL(req.url, 'http://localhost:3000/api/video-stream');
          const targetUrl = reqUrl.searchParams.get('url') || '';
          const driveId = reqUrl.searchParams.get('id') || extractDriveId(targetUrl);

          // Check if local public video exists
          const localPath = path.resolve(__dirname, 'public/cs2-cinematic.mp4');
          if ((driveId === '1K31UotdiJzBZqPuif1Qw61R6_QqQdCh9' || !driveId) && fs.existsSync(localPath)) {
            const stat = fs.statSync(localPath);
            const fileSize = stat.size;
            const range = req.headers.range;

            if (range) {
              const parts = range.replace(/bytes=/, '').split('-');
              const start = parseInt(parts[0], 10);
              const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
              const chunksize = end - start + 1;
              const fileStream = fs.createReadStream(localPath, { start, end });
              res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'video/mp4',
                'Access-Control-Allow-Origin': '*',
              });
              res.on('close', () => fileStream.destroy());
              fileStream.on('error', () => res.end());
              fileStream.pipe(res);
            } else {
              res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': 'video/mp4',
                'Accept-Ranges': 'bytes',
                'Access-Control-Allow-Origin': '*',
              });
              const fileStream = fs.createReadStream(localPath);
              res.on('close', () => fileStream.destroy());
              fileStream.on('error', () => res.end());
              fileStream.pipe(res);
            }
            return;
          }

          // Proxy remote stream from Google Drive or direct URL
          let streamTarget = targetUrl;
          if (driveId) {
            streamTarget = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(driveId)}&export=download&confirm=t`;
          }

          if (!streamTarget) {
            res.statusCode = 400;
            res.end('Missing video URL or ID');
            return;
          }

          const parsed = new URL(streamTarget);
          const client = parsed.protocol === 'https:' ? https : http;
          const headers: Record<string, string> = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          };
          if (req.headers.range) {
            headers['Range'] = req.headers.range;
          }

          client.get(streamTarget, { headers }, (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode || 200, {
              'Content-Type': upstreamRes.headers['content-type'] || 'video/mp4',
              'Content-Length': upstreamRes.headers['content-length'] || '',
              'Content-Range': upstreamRes.headers['content-range'] || '',
              'Accept-Ranges': upstreamRes.headers['accept-ranges'] || 'bytes',
              'Access-Control-Allow-Origin': '*',
            });
            upstreamRes.pipe(res);
          }).on('error', (err) => {
            console.error('Video proxy stream error:', err);
            res.statusCode = 502;
            res.end('Upstream stream error');
          });
        } catch (e) {
          console.error('Video stream middleware error:', e);
          res.statusCode = 500;
          res.end('Internal Server Error');
        }
      });
    }
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), videoStreamPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
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
