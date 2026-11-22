#!/usr/bin/env node
import { runWeights } from "../src/cli.mjs";

process.exitCode = await runWeights(process.argv.slice(2));
