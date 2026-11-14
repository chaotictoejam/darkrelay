# Security

DarkRelay runs in your own AWS account and holds OAuth tokens, access logs with IP addresses, and unpublished episodes. Security reports are taken seriously.

## Reporting a vulnerability

Please **do not** open a public issue. Report it privately through [GitHub's private vulnerability reporting](https://github.com/chaotictoejam/darkrelay/security/advisories/new).

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply within a week.

## Scope

In scope: anything in this repository, including the CDK stacks, IAM policies, Lambda handlers, the dashboard and the CLI.

Out of scope: misconfiguration of your own AWS account, and issues in AWS, YouTube or Podcast Index themselves.
