#!/usr/bin/env python3
"""Commit only validated data, then explicitly request the existing Pages build."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
PATHS = ['assets/data.js', 'data/recipes.json', 'data/raw-full.json', 'data/nutrition', 'data/collection', 'data/food-safety', 'data/food-links.json.gz', 'data/integration-status.json', 'data/collection-runs.json', 'data/collection-status.json', 'data-status.html']

def git(*args, output=False):
    result = subprocess.run(['git', *args], cwd=ROOT, check=True, text=True, stdout=subprocess.PIPE if output else None)
    return result.stdout.strip() if output else None

def api(path, method='GET'):
    repository = os.environ['GITHUB_REPOSITORY']
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('Invalid repository')
    request = Request('https://api.github.com/repos/' + repository + '/' + path, method=method, headers={'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'foodhannun-data-sync'})
    try:
        with urlopen(request, timeout=60) as response:
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError('GitHub Pages request failed: HTTP ' + str(error.code)) from None

def publish(mode):
    git('config', 'user.name', 'github-actions[bot]')
    git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
    existing = [relative for relative in PATHS if (ROOT / relative).exists()]
    git('add', '--', *existing)
    if not git('diff', '--cached', '--name-only', output=True):
        print('No validated data changes to publish.')
        return
    git('commit', '-m', 'data: automatically refresh verified ' + mode + ' snapshots')
    git('fetch', 'origin', 'main')
    # Concurrent code changes can be replayed; data conflicts stop instead of overwriting.
    git('rebase', 'origin/main')
    git('push', 'origin', 'HEAD:main')
    expected = git('rev-parse', 'HEAD', output=True)
    api('pages/builds', 'POST')
    print('Requested existing GitHub Pages deployment for ' + expected, flush=True)
    for _ in range(30):
        build = api('pages/builds/latest')
        if build.get('commit') == expected:
            if build.get('status') == 'built':
                print('Pages build succeeded for the published data commit.', flush=True)
                return
            if build.get('status') == 'errored':
                raise RuntimeError('Published data commit could not be built by GitHub Pages')
        time.sleep(20)
    raise RuntimeError('Pages build did not confirm the published commit within 10 minutes')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', required=True, choices=['recalls', 'daily', 'weekly', 'recipes', 'nutrition', 'official-all'])
    publish(parser.parse_args().mode)
