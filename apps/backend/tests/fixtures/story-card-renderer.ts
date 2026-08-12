const input = JSON.parse(await Bun.stdin.text()) as { outputPath: string };
await Bun.write(input.outputPath, "test story card");
