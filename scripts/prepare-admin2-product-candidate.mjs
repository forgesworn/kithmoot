#!/usr/bin/env node
/** Compare an optional local source with the tracked exact qualification bytes. */
import { resolve } from 'node:path'
import { candidateDirectory, verifyCandidateDirectory } from './admin2-product-candidate.mjs'
if (process.argv.length !== 3) throw new Error('Usage: node scripts/prepare-admin2-product-candidate.mjs <exact local qualification web directory>')
verifyCandidateDirectory(candidateDirectory)
verifyCandidateDirectory(resolve(process.argv[2]))
console.log('Exact Admin2 qualification source matches the tracked input; qualificationOnly and experimental provenance retained.')
