# Security Policy

Silica runs entirely in your browser (or in Node for the command line). It has no server, no accounts and sends
nothing anywhere. Projects are stored in your browser's local storage, in files you save, or inside share links.

## Reporting

Please report security problems privately through
[GitHub private vulnerability reporting](https://github.com/jullewz/silica/security/advisories/new).

Relevant problems include:

- a project file or share link that runs script in the page (for example through a label or circuit name)
- a project file or share link that freezes the page or the command line without the oscillation guard catching it
- the development server serving files outside the project folder

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
