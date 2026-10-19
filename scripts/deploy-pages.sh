#!/usr/bin/env bash
# Create this new static project and publish main:/ through GitHub Pages.
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
target_repo="${1:-softm/foodhannun}"
cd "$project_dir"

if ! [[ "$target_repo" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$ ]]; then
  printf '%s\n' '오류: 저장소는 owner/name 형식이어야 합니다.' >&2
  exit 2
fi
for dependency in git gh; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    printf '오류: %s 설치가 필요합니다. README의 실행 안내를 확인하세요.\n' "$dependency" >&2
    exit 2
  fi
done
gh auth status >/dev/null
account_login="$(gh api user --jq .login)"
account_id="$(gh api user --jq .id)"
if [[ "${target_repo%%/*}" != "$account_login" ]]; then
  printf '오류: 연결 계정 %s와 대상 저장소 소유자가 다릅니다.\n' "$account_login" >&2
  exit 2
fi

repo_exists=false
if gh repo view "$target_repo" --json name >/dev/null 2>&1; then
  repo_exists=true
fi
if [[ ! -d .git ]]; then
  if git rev-parse --show-toplevel >/dev/null 2>&1; then
    printf '%s\n' '오류: 다른 Git 저장소 안에 있습니다. 이 프로젝트를 독립 폴더로 옮겨 실행하세요.' >&2
    exit 2
  fi
  if [[ "$repo_exists" == true ]]; then
    remote_branch="$(gh repo view "$target_repo" --json defaultBranchRef --jq '.defaultBranchRef.name // ""')"
    if [[ -n "$remote_branch" ]]; then
      printf '%s\n' '오류: 원격 저장소에 기존 이력이 있습니다. 해당 저장소를 clone한 폴더에서 이 파일을 적용하세요.' >&2
      exit 2
    fi
  fi
  git init -b main
fi

if [[ "$(git branch --show-current)" != main ]]; then
  printf '%s\n' '오류: 현재 브랜치가 main이 아닙니다. 브랜치를 확인한 뒤 실행하세요.' >&2
  exit 2
fi
remote_url="$(git remote get-url origin 2>/dev/null || true)"
if [[ -n "$remote_url" && "$remote_url" != "https://github.com/${target_repo}.git" && "$remote_url" != "https://github.com/${target_repo}" && "$remote_url" != "git@github.com:${target_repo}.git" ]]; then
  printf '%s\n' '오류: origin이 다른 저장소를 가리킵니다. 기존 설정을 보존하고 중단합니다.' >&2
  exit 2
fi

git add index.html assets data scripts README.md .gitignore .nojekyll
if ! git diff --cached --quiet; then
  author_name="$(git config user.name || true)"
  author_email="$(git config user.email || true)"
  git -c "user.name=${author_name:-$account_login}" -c "user.email=${author_email:-${account_id}+${account_login}@users.noreply.github.com}" commit -m 'Build foodhannun static food search app'
fi

if [[ "$repo_exists" == false ]]; then
  gh repo create "$target_repo" --public --description '음식한눈 — 음식명·재료 통합 검색, 레시피·영양·장보기 모바일 웹' --source . --remote origin --push
else
  if [[ -z "$remote_url" ]]; then
    git remote add origin "https://github.com/${target_repo}.git"
  fi
  git push -u origin main
fi

pages_method=POST
if gh api "repos/${target_repo}/pages" >/dev/null 2>&1; then
  pages_method=PUT
fi
gh api --method "$pages_method" "repos/${target_repo}/pages" --input - <<'JSON'
{"build_type":"legacy","source":{"branch":"main","path":"/"}}
JSON
printf '\n저장소: https://github.com/%s\n' "$target_repo"
gh api "repos/${target_repo}/pages" --jq '{status: .status, url: .html_url, source: .source}'
printf '%s\n' '설정과 푸시를 완료했습니다. status가 built가 될 때까지 GitHub Pages의 배포 상태를 확인하세요.'
