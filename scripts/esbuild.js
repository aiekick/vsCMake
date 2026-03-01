const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
    // Extension (Node) context
    const extCtx = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        outfile: 'out/extension.js',
        external: ['vscode'],
        logLevel: 'warning',
        plugins: [esbuildProblemMatcherPlugin]
    });

    // Webview (Browser) context — bundles into a single IIFE file
    const webCtx = await esbuild.context({
        entryPoints: ['src/webview/graph_webview.ts'],
        bundle: true,
        format: 'iife',
        minify: production,
        sourcemap: false,
        sourcesContent: false,
        platform: 'browser',
        outfile: 'out/webview/graph_webview.js',
        logLevel: 'warning',
        plugins: [esbuildProblemMatcherPlugin]
    });

    if (watch) {
        await Promise.all([extCtx.watch(), webCtx.watch()]);
    } else {
        await Promise.all([extCtx.rebuild(), webCtx.rebuild()]);
        await Promise.all([extCtx.dispose(), webCtx.dispose()]);
    }
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
    name: 'esbuild-problem-matcher',

    setup(build) {
        build.onStart(() => {
            console.log('[watch] build started');
        });
        build.onEnd(result => {
            result.errors.forEach(({ text, location }) => {
                console.error(`✘ [ERROR] ${text}`);
                if (location == null) return;
                console.error(`    ${location.file}:${location.line}:${location.column}:`);
            });
            console.log('[watch] build finished');
        });
    }
};

main().catch(e => {
    console.error(e);
    process.exit(1);
});
