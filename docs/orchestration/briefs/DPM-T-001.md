=== TASK BRIEF ===
TASK ID:         DPM-T-001
TITLE:           Initialize Git repository, configure .gitignore, and push main branch
ASSIGNED TO:     A-OPS-1 (DevOps)
PRIORITY:        P0
DEPENDS ON:      none
PROJECT:         dpMaps | ROOT: /home/zia/Documents/My Projects/dpMaps | CONTEXT FILE: /home/zia/Documents/My Projects/dpMaps/AGENTS.md
SOURCE OF TRUTH: ORCHESTRATOR.md §10, AGENTS.md §1–§5, remote repository https://github.com/dannyzia/dpMap.git
OS / SHELL:      Linux / bash (or Windows 11 / PowerShell 7)

You are A-OPS-1, role DevOps, working on the project "dpMaps" at /home/zia/Documents/My Projects/dpMaps.
You have no memory of earlier work. Everything you need is in this brief and the files it lists.
1. Read the project context file (/home/zia/Documents/My Projects/dpMaps/AGENTS.md) before anything else. Its hard rules
   override this brief. If they conflict with this brief, stop and report BLOCKED.
2. Do exactly what this brief says. Do no extra work. Do not refactor, rename, or reformat
   anything not listed under SCOPE.
3. Touch only the files listed under SCOPE. If you need another file, stop and report BLOCKED.
4. Do not invent facts, numbers, prices, terms, or laws. If you do not know, write UNKNOWN
   and say exactly what is needed.
5. Run every step under VERIFICATION and paste the real output. Never write "should work"
   or "tests pass" without pasted output.
6. Never print, store, or request secrets, credentials, or personal data.
7. If anything is ambiguous, stop and put exactly one question under QUESTIONS in your
   report. Do not guess.
8. If you cannot complete a step, report BLOCKED with the reason. Do not improvise a
   workaround.
9. Finish by writing the TASK REPORT in the exact format given at the end of this brief.

CONTEXT
The official dpMaps Git repository is established at https://github.com/dannyzia/dpMap.git.
The local workspace directory (/home/zia/Documents/My Projects/dpMaps) needs its local Git tracking initialized and linked to remote origin https://github.com/dannyzia/dpMap.git.
The baseline code, plans, resources, and orchestration files must be committed and pushed to main so all subsequent work can run on isolated task branches per ORCHESTRATOR.md §10.

OBJECTIVE
Link local project workspace to remote repository https://github.com/dannyzia/dpMap.git on branch main, configure .gitignore, commit the baseline files, and push main.

SCOPE (the ONLY files you may create or modify)
- /home/zia/Documents/My Projects/dpMaps/.gitignore — create

OUT OF SCOPE (you MUST NOT do these)
- Do not modify, reformat, or rename any file in docs/, .agents/, AGENTS.md, ORCHESTRATOR.md, or dpMaps.code-workspace.
- Do not delete or move any resource file under docs/resources/.
- Do not create or switch to any branch other than main in this task.

INPUTS (read these first)
- /home/zia/Documents/My Projects/dpMaps/AGENTS.md (sections 1 through 5)
- /home/zia/Documents/My Projects/dpMaps/ORCHESTRATOR.md (section 10)

REQUIREMENTS (numbered; each is testable)
R1. MUST initialize a Git repository at /home/zia/Documents/My Projects/dpMaps with default branch main.
R2. MUST create /home/zia/Documents/My Projects/dpMaps/.gitignore containing ignore rules for:
    - OS metadata (.DS_Store, Thumbs.db, desktop.ini)
    - IDE metadata (.vscode/* except extensions/settings if needed; .idea/)
    - Node dependencies and logs (node_modules/, *.log, npm-debug.log*, yarn-error.log*)
    - Python virtual environments and caches (__pycache__/, *.py[cod], .venv/, venv/, env/)
    - Secret and environment configuration files (.env, .env.*.local, *.pem, *.key)
    - Scratch directories (scratch/, tmp/)
R3. MUST stage the baseline files and commit with exact commit message:
    "chore: initial dpMaps engineering baseline and orchestration infrastructure"
R4. MUST configure remote "origin" to "https://github.com/dannyzia/dpMap.git".
R5. MUST push branch "main" to remote "origin" (with upstream tracking -u).

HARD RULES THAT APPLY (cite the project context file by rule number)
- Rule 1: Clean room — verify zero vendor credentials, tokens, or unauthorized scraped data are staged.
- Rule 8: Privacy by default — verify no personal credentials, tokens, or secrets exist in committed files.

ACCEPTANCE CRITERIA (each maps to a check)
A1. Git repository active on branch main — verified by: `git branch --show-current` — expected: `main`
A2. .gitignore file exists with required entries — verified by: `git check-ignore -v .env node_modules scratch/` — expected: each path matched by .gitignore
A3. Remote origin set to specified GitHub URL — verified by: `git remote get-url origin` — expected: `https://github.com/dannyzia/dpMap.git`
A4. Initial commit recorded and pushed — verified by: `git log -1 --oneline` and `git status` — expected: commit present and working tree clean / up-to-date with origin/main.

VERIFICATION (run in order; paste output)
1. `git branch --show-current`
2. `git remote -v`
3. `git log -1 --oneline`
4. `git status`

STOP CONDITIONS (stop and report BLOCKED if)
- Git command fails due to permission errors or unresolvable authentication to https://github.com/dannyzia/dpMap.git.
- Any conflict occurs with remote contents (remote was expected to be empty).

REPORT FORMAT: TASK REPORT (below). Return it to the Orchestrator via Zia.
=== END BRIEF ===

=== TASK REPORT ===
TASK ID:
AGENT ID:
STATUS:          DONE | PARTIAL | BLOCKED | FAILED
SUMMARY:         <max 5 lines>
FILES CHANGED:   <path — create/modify/delete — one-line reason>
COMMANDS RUN:    <each command, then the real output (trim to 40 lines; save longer logs to
                  docs/orchestration/reports/<TASK ID>.log and give the path)>
ACCEPTANCE:      A1 PASS|FAIL — evidence | A2 ... (every criterion listed)
DEVIATIONS:      <anything done differently from the brief, and why; "none" if none>
ASSUMPTIONS:     <list; "none" if none>
OPEN ISSUES:     <list; "none" if none>
QUESTIONS:       <exactly one, or "none">
=== END REPORT ===
