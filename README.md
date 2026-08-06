# Geota Jujak Satongpaldal Monitor

주작 서버 사통팔달 페이지를 GitHub Actions에서 5분마다 확인합니다.

## 동작
- 매 실행 최대 300개 수집
- 닉네임 + 내용 기준 중복 병합
- 마지막 확인 시점 기준 최근 24시간 보관
- `docs/data.json`에 저장
- GitHub Pages에서 검색 가능

## 첫 실행
1. 저장소 루트에 이 프로젝트의 **내용물 전체**를 업로드합니다.
2. Actions 탭에서 `Collect Geota Jujak Satongpaldal`을 선택합니다.
3. `Run workflow`를 누릅니다.
4. Settings → Pages → Deploy from a branch
5. Branch: `main`, Folder: `/docs`로 저장합니다.

## 중요
거타 사이트의 화면 구조가 변경되거나 GitHub 실행기 접근을 차단하면 수집이 실패할 수 있습니다.
이 경우 Actions 실행 로그의 `Collect posts` 오류를 확인해야 합니다.
