# 서울 중계 (선택 기능)

일부 예약처(예: 대야도 피싱아일랜드)는 해외 서버의 접속을 막아 두어서, Render(미국)에서는 "연결 시간 초과"로 열리지 않아요.
이 폴더의 작은 함수를 **서울 지역**에서 돌려 두면, 서울에서 대신 사이트를 열어서 Render로 전해 줘요.

- 안 만들어도 앱은 지금처럼 잘 돌아가요. (필요한 예약처만 안 불러와질 뿐이에요.)
- **한국 IP는 열어 주는 사이트**라면 해결돼요. 사이트가 한국 IP까지 막고 있으면 이 방법으로도 안 열려요. 그건 아래 5번 시험에서 바로 알 수 있어요.
- Vercel 무료(Hobby) 플랜은 개인·비상업 용도예요.
- 시작하기 전에: 이 폴더(`seoul-relay`)가 GitHub 저장소(`fishing-booking`)에 올라가 있어야 해요.

## 설치 순서 (약 15분)

**1. 토큰 정하기**
비밀번호처럼 길고 아무도 모르는 글자를 하나 정해요(영문+숫자 30자 이상). 메모해 두세요. 이 값을 아래 3번과 6번에 **똑같이** 넣어요.

**2. Vercel 가입**
https://vercel.com → Sign Up → "Continue with GitHub" (Hobby 선택).

**3. 프로젝트 만들기**
Add New… → Project → GitHub 저장소 `fishing-booking`을 Import.
- **Root Directory**: `Edit`을 눌러 `seoul-relay` 폴더를 고르세요. (이걸 빼먹으면 안 돼요.)
- **Environment Variables**: Name에 `RELAY_TOKEN`, Value에 1번의 토큰을 넣고 Add.
- 나머지(Framework Preset, Build Command 등)는 그대로 두고 **Deploy**.

**4. 서울에서 도는지 확인**
배포가 끝나면 프로젝트 화면의 **Domains**에 `프로젝트이름.vercel.app` 같은 짧은 주소가 보여요. (배포마다 바뀌는 긴 주소 말고 이 짧은 주소를 쓰세요.)
브라우저 주소창에 아래처럼 넣어 보세요.

```
https://프로젝트이름.vercel.app/api/relay?token=내토큰&ping=1
```

`{"ok":true,"region":"icn1"}` 이 보이면 서울(icn1)이에요. 다른 값이면 Vercel 프로젝트의 Settings → Functions → Function Region을 `Seoul, South Korea (icn1)`로 바꾸고 다시 배포(Redeploy)하세요.

**5. 대야도 사이트가 열리는지 시험**

```
https://프로젝트이름.vercel.app/api/relay?token=내토큰&url=http://fishingi.net/index.php
```

사이트 화면이 (모양이 깨져 보여도) 글자와 함께 나오면 성공이에요. 아래 표 같은 오류 글이 나오면 표를 보세요.

**6. Render에 연결**
Render → `fishing-app-v2` → Environment → 환경변수 추가:

| 이름 | 값 |
|---|---|
| `FISHING_RELAY_URL` | `https://프로젝트이름.vercel.app/api/relay` |
| `FISHING_RELAY_TOKEN` | 1번의 토큰 (3번과 똑같이) |
| `FISHING_RELAY_HOSTS` (권장) | `fishingi.net` — 처음부터 중계로만 열 사이트. 쉼표로 여러 개 가능. 넣으면 첫 조회에서 직접 연결을 10초 기다리는 일이 없어져요 |

저장하면 자동으로 다시 배포돼요. (`FISHING_RELAY_HOSTS`를 안 넣어도, 직접 연결이 안 되는 사이트는 자동으로 중계로 다시 시도해요. 다만 서버가 새로 켜진 뒤 첫 조회는 직접 연결을 10초 기다린 다음 중계로 넘어가요.)

**7. 확인**
앱에서 대야도가 포함되게 '자리 찾기'를 눌러 보세요. 일정이 나오면 성공이에요.
`/api/fishing/diagnostics` 에서 `relay.configured: true`, 대야도 줄의 `via: "relay"`가 보이면 중계로 열린 거예요.

## 문제가 생기면

5번 화면(또는 앱의 "원인:")에 이런 글이 나오면:

| 보이는 글 | 뜻 | 할 일 |
|---|---|---|
| `토큰이 맞지 않아요` / 중계 서버 토큰이 맞지 않음 | 두 곳의 토큰이 달라요 | Vercel `RELAY_TOKEN`과 Render `FISHING_RELAY_TOKEN`을 똑같이 맞추세요. Vercel은 값을 바꾼 뒤 Redeploy가 필요해요 |
| 중계 서버 주소가 맞지 않음 HTTP 404 | `FISHING_RELAY_URL`이 틀렸어요 | 끝이 `/api/relay`인지, 짧은 Domains 주소인지 확인 |
| 중계 서버가 접근을 막음 HTTP 401 | Vercel의 보호 기능이 막고 있어요 | 짧은 Domains 주소를 쓰세요. 그래도 안 되면 Settings → Deployment Protection을 확인 |
| 중계 서버에 연결하지 못함 | 주소 오타 또는 Vercel 점검 | 주소를 확인하고 잠시 뒤 다시 |
| 서울 중계로도 못 열림: 연결 시간 초과 | 서울에서도 안 열려요 → 사이트가 한국 IP까지 막았거나 사이트 문제 | 사이트 운영자에게 문의하거나, 앱의 '직접 열기' 링크로 확인 |
| 서울 중계로도 못 열림: 응답 시간 초과 12초 | 사이트가 너무 느려요 | 잠시 뒤 다시 |
| HTTP 403 서울 중계 경유 | 사이트가 중계도 거부해요 | 앱의 '직접 열기' 링크로 확인 |

## 알아 둘 것

- 토큰을 아는 사람만 이 중계를 쓸 수 있어요. 토큰은 비밀번호처럼 다루고, 코드나 GitHub에 쓰지 말고 Vercel·Render 설정 화면에만 넣으세요.
- 4·5번처럼 주소창에 토큰을 넣어 시험하면 브라우저 기록과 Vercel 로그에 토큰이 남을 수 있어요. 마음에 걸리면 시험이 끝난 뒤 토큰을 새로 정해서 Vercel(`RELAY_TOKEN`)과 Render(`FISHING_RELAY_TOKEN`) 양쪽을 바꾸세요. (앱은 토큰을 주소가 아니라 헤더로 보내요.)
- 중계는 공개된 `http/https` 주소만 열고, 내부 주소(localhost, 192.168.* 등)는 거부해요.
- 끄려면 Render에서 `FISHING_RELAY_URL`을 지우세요. 그러면 예전처럼 직접 연결만 해요.
- 동작 방식: 평소에는 Render가 사이트에 직접 연결해요. 직접 연결이 안 될 때(연결 시간 초과·거부·끊김)나 403일 때만 이 중계로 한 번 더 시도하고, 중계로 성공한 사이트는 6시간 동안 곧바로 중계로 열어요.
