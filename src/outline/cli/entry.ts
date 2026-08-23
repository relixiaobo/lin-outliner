#!/usr/bin/env node
import { runOutlineCli } from './runner';

process.exitCode = await runOutlineCli(process.argv.slice(2));
