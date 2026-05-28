// Dev runner for qwen-provider: start the simple proxy server with frontend hot rebuild
import { simpleProxyServer } from './server';
import fs from 'fs';
import path from 'path';

const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '127.0.0.1';

const sourceDir = './frontend/src';
const outJs = './public/assets/proxy-luna-app.js';
const mainJs = './public/assets/main.js';
const outCss = './public/styles.css';

// Lấy thời gian sửa đổi mới nhất trong thư mục nguồn
function getLatestMtime(dir: string): number {
	let latest = 0;
	if (!fs.existsSync(dir)) return latest;
	
	function walk(currentDir: string) {
		const files = fs.readdirSync(currentDir);
		for (const file of files) {
			const fullPath = path.join(currentDir, file);
			const stat = fs.statSync(fullPath);
			if (stat.isDirectory()) {
				walk(fullPath);
			} else {
				if (stat.mtimeMs > latest) {
					latest = stat.mtimeMs;
				}
			}
		}
	}
	walk(dir);
	return latest;
}

// Kiểm tra xem frontend có thay đổi so với bản build cũ không
function shouldRebuild(): boolean {
	if (!fs.existsSync(outJs) || !fs.existsSync(outCss)) {
		return true;
	}
	const sourceLatest = getLatestMtime(sourceDir);
	const outJsMtime = fs.statSync(outJs).mtimeMs;
	const outCssMtime = fs.statSync(outCss).mtimeMs;
	return sourceLatest > outJsMtime || sourceLatest > outCssMtime;
}

// Thực hiện build frontend
async function buildFrontend(): Promise<boolean> {
	const start = performance.now();
	try {
		const result = await Bun.build({
			entrypoints: ['./frontend/src/main.tsx'],
			outdir: './public/assets',
			minify: false, // Dev build không cần minify để build siêu nhanh
		});

		if (!result.success) {
			console.error('[Frontend Build] Biên dịch thất bại:', result.logs);
			return false;
		}

		// Bun build ra main.js, đổi tên thành proxy-luna-app.js
		if (fs.existsSync(mainJs)) {
			try {
				fs.copyFileSync(mainJs, outJs);
				fs.unlinkSync(mainJs);
			} catch (err) {
				// Fallback sang rename nếu copy lỗi
				if (fs.existsSync(outJs)) {
					try { fs.unlinkSync(outJs); } catch {}
				}
				fs.renameSync(mainJs, outJs);
			}
		}

		// Sao chép CSS
		fs.copyFileSync('./frontend/src/styles.css', outCss);

		const duration = (performance.now() - start).toFixed(0);
		console.log(`[Frontend Build] Đã build xong giao diện mới trong ${duration}ms!`);
		return true;
	} catch (err) {
		console.error('[Frontend Build] Lỗi ngoại lệ khi build:', err);
		return false;
	}
}

(async () => {
	try {
		// 1. Kiểm tra build thông minh trước khi start
		if (shouldRebuild()) {
			console.log('[Frontend] Phát hiện mã nguồn thay đổi, đang tự động build lại...');
			await buildFrontend();
		} else {
			console.log('[Frontend] Giao diện không đổi (sử dụng bản build đã cache).');
		}

		// 2. Thiết lập Watcher tự động rebuild khi có thay đổi code
		let debounceTimeout: Timer | null = null;
		if (fs.existsSync(sourceDir)) {
			console.log(`[Watcher] Đang theo dõi các thay đổi trong thư mục ${sourceDir}...`);
			fs.watch(sourceDir, { recursive: true }, (eventType, filename) => {
				if (filename) {
					if (debounceTimeout) clearTimeout(debounceTimeout);
					debounceTimeout = setTimeout(async () => {
						console.log(`[Watcher] Phát hiện thay đổi tại ${filename}, đang rebuild giao diện...`);
						await buildFrontend();
					}, 150);
				}
			});
		}

		// 3. Khởi động server
		const portsToTry = [port, 8081, 3000, 0];
		const hostsToTry = [host, '0.0.0.0'];
		let started = false;
		for (const h of hostsToTry) {
			for (const p of portsToTry) {
				console.log(`Trying to start server on ${h}:${p}`);
				started = await simpleProxyServer.start(p, h);
				if (started) {
					console.log(`qwen-provider running in dev mode on ${h}:${p}`);
					break;
				}
				console.warn(`Port ${p} unavailable on ${h}, trying next`);
			}
			if (started) break;
		}
		if (!started) {
			console.error('Failed to start server on all tried ports');
			process.exit(1);
		}
	} catch (err) {
		console.error('Dev server error:', err);
		process.exit(1);
	}
})();

process.on('SIGINT', async () => {
	console.log('Stopping server...');
	//await simpleProxyServer.stop();
	process.exit(0);
});

export {};
