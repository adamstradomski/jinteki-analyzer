// Trace's two built-in example logs, for the "Log example 1/2" buttons. Kept out of
// app.js so the page doesn't download and parse ~65 KB of text on every load: app.js
// appends a <script src="examples.js"> the first time a button is clicked (that works
// from file:// too, unlike fetch()). Also read by the parser tests in test/trace/.
globalThis.TRACE_EXAMPLES = {
  example1: `Corp Player started his turn 1 with 5  and 5 cards in HQ.
Corp Player makes his mandatory start of turn draw.
Corp Player spends  to install a card in the root of Server 1 (new remote).
Corp Player pays 0  to rez Spin Doctor in Server 1.
Corp Player uses Spin Doctor to draw 2 cards.
Corp Player spends  and pays 0  to install ice protecting HQ.
Corp Player spends  to use Corp Basic Action Card to draw 1 card.
Corp Player discards 2 cards from HQ at end of turn.
Corp Player is ending his turn 1 with 5  and 5 cards in HQ.
Runner Player started his turn 1 with 5  and 5 cards in his Grip.
Runner Player spends  and pays 1  to install Touchstone.
Runner Player spends  and pays 3  to play Bravado.
Runner Player approaches ice protecting HQ at position 0.
Corp Player pays 5  to rez Starlit Knight protecting HQ at position 0.
Runner Player encounters Starlit Knight protecting HQ at position 0.
Runner Player indicates to fire all unbroken subroutines on Starlit Knight.
Corp Player uses Starlit Knight to give the Runner 1 tag.
Corp Player uses NBN: Reality Plus to gain 2 .
Corp Player uses Starlit Knight to give the Runner 1 tag.
Corp Player resolves 2 unbroken subroutines on Starlit Knight (" Give the Runner 1 tag" and " Give the Runner 1 tag").
Runner Player passes Starlit Knight protecting HQ at position 0.
Runner Player approaches HQ.
Runner Player breaches HQ.
Runner Player accesses Embedded Reporting from HQ.
Runner Player steals Embedded Reporting and gains 2 agenda points.
Runner Player uses Bravado to gain 7 .
Runner Player spends  and pays 2  to use Runner Basic Action Card to remove 1 tag.
Runner Player spends  and pays 2  to use Runner Basic Action Card to remove 1 tag.
Runner Player is ending his turn 1 with 4  and 3 cards in his Grip.
Corp Player uses Spin Doctor to shuffle 2 unseen cards into R&D.
Corp Player started his turn 2 with 2  and 4 cards in HQ.
Corp Player makes his mandatory start of turn draw.
Corp Player spends  to use Corp Basic Action Card to draw 1 card.
Corp Player spends  and pays 0  to install ice protecting R&D.
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player is ending his turn 2 with 3  and 5 cards in HQ.
Runner Player started his turn 2 with 4  and 3 cards in his Grip.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  and pays 2  to install Revolver.
Runner Player spends  and pays 0  to play Transfer of Wealth.
Runner Player uses Transfer of Wealth to make a run on HQ.
Runner Player approaches Starlit Knight protecting HQ at position 0.
Corp Player has no further action.
Runner Player encounters Starlit Knight protecting HQ at position 0.
Runner Player pays 2  from Touchstone and spends 2 hosted power counters from on Revolver to increase the strength of Revolver to 4 and break all 2 subroutines on Starlit Knight.
Runner Player has no further action.
Runner Player passes Starlit Knight protecting HQ at position 0.
Runner Player approaches HQ.
Runner Player uses Transfer of Wealth to take 1 tagand force the Corp to lose 3 , and then gain 6 .
Corp Player uses NBN: Reality Plus to gain 2 .
Runner Player breaches HQ.
Runner Player accesses Artificial Cryptocrash from HQ.
Runner Player steals Artificial Cryptocrash and gains 2 agenda points.
Runner Player spends  and pays 2  to use Runner Basic Action Card to remove 1 tag.
Runner Player is ending his turn 2 with 6  and 2 cards in his Grip.
Corp Player started his turn 3 with 2  and 4 cards in HQ.
Corp Player makes his mandatory start of turn draw.
Corp Player spends  to use Corp Basic Action Card to draw 1 card.
Corp Player spends  to install a card in the root of Server 2 (new remote).
Corp Player spends  to install a card in the root of Server 3 (new remote).
Corp Player is ending his turn 3 with 2  and 4 cards in HQ.
Runner Player started his turn 3 with 6  and 2 cards in his Grip.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  and pays 0  to install Dr. Nuka Vrolyck.
Runner Player is ending his turn 3 with 6  and 4 cards in his Grip.
Corp Player pays 1  to rez Balanced Coverage in Server 2.
Corp Player started his turn 4 with 1  and 4 cards in HQ.
Corp Player uses Balanced Coverage to choose Asset.
Corp Player declines to use Balanced Coverage to reveal the top card of R&D.
Corp Player makes his mandatory start of turn draw.
Corp Player spends  to install a card in the root of R&D.
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player spends  to install a card in the root of Server 4 (new remote).
Corp Player is ending his turn 4 with 2  and 3 cards in HQ.
Runner Player started his turn 4 with 6  and 4 cards in his Grip.
Runner Player spends  and spends 1 hosted power counter from on Dr. Nuka Vrolyck to use Dr. Nuka Vrolyck to draw 3 cards.
Runner Player spends  and pays 5  to play Sure Gamble.
Runner Player uses Sure Gamble to gain 9 .
Runner Player spends  and pays 2  to install Pennyshaver.
Runner Player spends  and pays 1  to install Cupellation.
Runner Player is ending his turn 4 with 7  and 4 cards in his Grip.
Corp Player started his turn 5 with 2  and 3 cards in HQ.
Corp Player uses Balanced Coverage to choose Asset.
Corp Player uses Balanced Coverage to reveal Wage Workers from the top of R&D and gain 2 .
Corp Player makes his mandatory start of turn draw.
Corp Player spends  to use Corp Basic Action Card to draw 1 card.
Corp Player spends  to install a card in the root of Server 5 (new remote).
Corp Player spends  to install a card in the root of Server 6 (new remote).
Corp Player is ending his turn 5 with 4  and 3 cards in HQ.
Runner Player started his turn 5 with 7  and 4 cards in his Grip.
Runner Player trashes Dr. Nuka Vrolyck.
Runner Player spends  and spends 1 hosted power counter from on Dr. Nuka Vrolyck to use Dr. Nuka Vrolyck to draw 3 cards.
Runner Player spends  and pays 3  to play Clean Getaway.
Runner Player uses Clean Getaway to make a run on Server 6.
Runner Player approaches Server 6.
Runner Player uses Clean Getaway to gain 6 .
Runner Player uses Pennyshaver to place 1 .
Runner Player breaches Server 6.
Runner Player accesses Wage Workers from Server 6.
Runner Player pays 1  from Touchstone to use Cupellation to host Wage Workers on itself.
Runner Player spends  to make a run on Server 5.
Runner Player approaches Server 5.
Runner Player uses Pennyshaver to place 1 .
Runner Player breaches Server 5.
Runner Player accesses Federal Fundraising from Server 5.
Runner Player pays 1  from Touchstone and 1  from his credit pool to trash Federal Fundraising from Server 5.
Runner Player spends  and pays 2  to install Hackerspace.
Runner Player is ending his turn 5 with 7  and 5 cards in his Grip.
Corp Player started his turn 6 with 4  and 3 cards in HQ.
Corp Player uses Balanced Coverage to choose Asset.
Corp Player uses Balanced Coverage to reveal Tiered Subscription from the top of R&D and gain 2 .
Corp Player makes his mandatory start of turn draw.
Corp Player spends  to use Corp Basic Action Card to draw 1 card.
Corp Player spends  to install a card in the root of Server 7 (new remote).
Corp Player spends  and pays 2  to play Oppo Research.
Corp Player uses Oppo Research to give the Runner 2 tags.
Corp Player uses NBN: Reality Plus to gain 2 .
Corp Player pays 5  to use Oppo Research to give the Runner 2 tags.
Corp Player is ending his turn 6 with 1  and 3 cards in HQ.
Corp Player pays 0  to rez Tiered Subscription in Server 7.
Runner Player started his turn 6 with 7  and 5 cards in his Grip.
Runner Player spends  and pays 5  to play Sure Gamble.
Runner Player uses Sure Gamble to gain 9 .
Runner Player spends  and pays 2  to use Runner Basic Action Card to remove 1 tag.
Runner Player spends  and pays 2  to use Runner Basic Action Card to remove 1 tag.
Runner Player spends  and pays 2  to use Runner Basic Action Card to remove 1 tag.
Runner Player is ending his turn 6 with 5  and 4 cards in his Grip.
Corp Player started his turn 7 with 1  and 3 cards in HQ.
Corp Player uses Balanced Coverage to choose Asset.
Corp Player declines to use Balanced Coverage to reveal the top card of R&D.
Corp Player makes his mandatory start of turn draw.
Corp Player spends  to use Corp Basic Action Card to draw 1 card.
Corp Player spends  to install a card in the root of Server 8 (new remote).
Corp Player spends  and pays 1  to play Retribution.
Corp Player uses Retribution to trash Pennyshaver.
Corp Player is ending his turn 7 with 0  and 3 cards in HQ.
Runner Player started his turn 7 with 5  and 4 cards in his Grip.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  and pays 2  to use Runner Basic Action Card to remove 1 tag.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  and pays 0  to install Paladin Poemu (paying 1  less) on Hackerspace.
Runner Player is ending his turn 7 with 3  and 5 cards in his Grip.
Corp Player pays 0  to rez Federal Fundraising in Server 8.
Corp Player started his turn 8 with 0  and 3 cards in HQ.
Corp Player uses Federal Fundraising to rearrange the top 3 cards of R&D.
Corp Player uses Federal Fundraising to draw 1 card.
Corp Player uses Balanced Coverage to choose Operation.
Corp Player uses Balanced Coverage to reveal Oppo Research from the top of R&D and gain 2 .
Corp Player makes his mandatory start of turn draw.
Corp Player pays 2  to rez Wage Workers in Server 3.
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player uses Wage Workers to gain .
Corp Player spends  to install a card in the root of Server 9 (new remote).
Corp Player is ending his turn 8 with 3  and 4 cards in HQ.
Runner Player started his turn 8 with 3  and 5 cards in his Grip.
Runner Player uses Paladin Poemu to add 1  to itself.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  and pays 2  to install The Class Act (paying 1  less) on Hackerspace.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  and pays 0  to install Fencer Fueno.
Runner Player is ending his turn 8 with 1  and 5 cards in his Grip.
Runner Player uses The Class Act to draw 4 cards.
Corp Player pays 0  to rez Spin Doctor in Server 9.
Corp Player uses Spin Doctor to draw 2 cards.
Corp Player started his turn 9 with 3  and 6 cards in HQ.
Corp Player uses Federal Fundraising to rearrange the top 3 cards of R&D.
Corp Player uses Federal Fundraising to draw 1 card.
Corp Player uses Balanced Coverage to choose Asset.
Corp Player uses Balanced Coverage to reveal Public Access Plaza from the top of R&D and gain 2 .
Corp Player makes his mandatory start of turn draw.
Corp Player spends  to install a card in the root of Server 10 (new remote).
Corp Player spends  to install a card in the root of Server 11 (new remote).
Corp Player spends  to install a card in the root of Server 12 (new remote).
Corp Player uses Wage Workers to gain .
Corp Player spends  to install a card in the root of Server 13 (new remote).
Corp Player is ending his turn 9 with 5  and 4 cards in HQ.
Runner Player started his turn 9 with 1  and 9 cards in his Grip.
Runner Player uses Paladin Poemu to add 1  to itself.
Runner Player uses Fencer Fueno to add 1  to itself.
Corp Player pays 0  to rez Tiered Subscription in Server 11.
Runner Player spends  and pays 2  from Paladin Poemu to install Pennyshaver.
Runner Player spends  to use Runner Basic Action Card to gain 1 .
Runner Player spends  to use Runner Basic Action Card to gain 1 .
Runner Player spends  and pays 3  to play Clean Getaway.
Runner Player uses Clean Getaway to make a run on Archives.
Corp Player uses Tiered Subscription to gain 1 .
Corp Player uses Tiered Subscription to gain 1 .
Runner Player approaches Archives.
Runner Player uses Clean Getaway to gain 6 .
Runner Player uses Pennyshaver to place 1 .
Runner Player breaches Archives.
Runner Player accesses everything else in Archives.
Runner Player is ending his turn 9 with 6  and 7 cards in his Grip.
Corp Player pays 1  to rez Public Access Plaza in Server 12.
Corp Player started his turn 10 with 6  and 4 cards in HQ.
Corp Player uses Public Access Plaza to gain 1 .
Corp Player uses Federal Fundraising to rearrange the top 3 cards of R&D.
Corp Player declines to use Federal Fundraising to draw 1 card.
Corp Player uses Balanced Coverage to choose Asset.
Corp Player uses Balanced Coverage to reveal Federal Fundraising from the top of R&D and gain 2 .
Corp Player makes his mandatory start of turn draw.
Corp Player spends  and pays 1  to use Corp Basic Action Card to advance a card in Server 10.
Corp Player spends  and pays 1  to use Corp Basic Action Card to advance a card in Server 10.
Corp Player spends  and pays 1  to use Corp Basic Action Card to advance a card in Server 10.
Corp Player uses Wage Workers to gain .
Corp Player spends  and pays 1  to use Corp Basic Action Card to advance a card in Server 10.
Corp Player scores Artificial Cryptocrash and gains 2 agenda points.
Corp Player uses Artificial Cryptocrash to make the Runner lose 7 .
Corp Player is ending his turn 10 with 5  and 5 cards in HQ.
Runner Player started his turn 10 with 0  and 7 cards in his Grip.
Runner Player uses Paladin Poemu to add 1  to itself.
Runner Player uses Fencer Fueno to add 1  to itself.
Runner Player spends  and pays 0  to install Debbie "Downtown" Moreira (paying 1  less) on Hackerspace.
Runner Player uses Debbie "Downtown" Moreira to place 2  on itself.
Runner Player spends  to use Pennyshaver to gain 2 .
Runner Player spends  and pays 0  to play Transfer of Wealth.
Runner Player uses Transfer of Wealth to make a run on HQ.
Corp Player uses Tiered Subscription to gain 1 .
Corp Player uses Tiered Subscription to gain 1 .
Runner Player approaches Starlit Knight protecting HQ at position 0.
Corp Player has no further action.
Runner Player encounters Starlit Knight protecting HQ at position 0.
Runner Player pays 2  from Touchstone and spends 2 hosted power counters from on Revolver to increase the strength of Revolver to 4 and break all 2 subroutines on Starlit Knight.
Runner Player has no further action.
Runner Player passes Starlit Knight protecting HQ at position 0.
Runner Player will continue the run.
Runner Player approaches HQ.
Runner Player uses Transfer of Wealth to take 1 tagand force the Corp to lose 3 , and then gain 6 .
Corp Player uses NBN: Reality Plus to draw 2 cards.
Runner Player uses Pennyshaver to place 1 .
Runner Player breaches HQ.
Cupellation has left play: Wage Workers is trashed.
Runner Player pays 1  from Touchstone and trashes Cupellation to use Cupellation to access 2 additional cards from HQ.
Runner Player accesses Federal Fundraising from HQ.
Runner Player accesses Funhouse from HQ.
Runner Player accesses Balanced Coverage from HQ.
Runner Player spends  and pays 2  to use Runner Basic Action Card to remove 1 tag.
Runner Player is ending his turn 10 with 6  and 5 cards in his Grip.
Corp Player started his turn 11 with 4  and 7 cards in HQ.
Corp Player uses Public Access Plaza to gain 1 .
Corp Player uses Federal Fundraising to rearrange the top 3 cards of R&D.
Corp Player uses Federal Fundraising to draw 1 card.
Corp Player uses Balanced Coverage to choose Asset.
Corp Player uses Balanced Coverage to reveal Tiered Subscription from the top of R&D and gain 2 .
Corp Player makes his mandatory start of turn draw.
Corp Player spends  to install a card in the root of Server 14 (new remote).
Corp Player spends  to install a card in the root of Server 15 (new remote).
Corp Player spends  to install a card in the root of Server 16 (new remote).
Corp Player uses Wage Workers to gain .
Corp Player spends  to install a card in the root of Server 17 (new remote).
Corp Player is ending his turn 11 with 7  and 5 cards in HQ.
Runner Player started his turn 11 with 6  and 5 cards in his Grip.
Runner Player uses Paladin Poemu to add 1  to itself.
Runner Player uses Fencer Fueno to add 1  to itself.
Runner Player spends  and pays 5  to play Sure Gamble.
Runner Player uses Sure Gamble to gain 9 .
Runner Player spends  to use Debbie "Downtown" Moreira to make a run on Server 14.
Corp Player uses Tiered Subscription to gain 1 .
Corp Player uses Tiered Subscription to gain 1 .
Runner Player approaches Server 14.
Runner Player uses Pennyshaver to place 1 .
Runner Player breaches Server 14.
Runner Player accesses Tomorrow's Headline from Server 14.
Runner Player steals Tomorrow's Headline and gains 2 agenda points.
Runner Player uses Paladin Poemu to add 1  to itself.
Runner Player uses Fencer Fueno to add 1  to itself.
Corp Player uses Tomorrow's Headline to give the Runner 1 tag.
Corp Player uses NBN: Reality Plus to draw 2 cards.
Runner Player spends  to use Debbie "Downtown" Moreira to make a run on Server 15.
Corp Player pays 1  to rez Public Access Plaza in Server 15.
Runner Player approaches Server 15.
Runner Player uses Pennyshaver to place 1 .
Runner Player breaches Server 15.
Runner Player accesses Public Access Plaza from Server 15.
Runner Player spends  and pays 2  to use Runner Basic Action Card to remove 1 tag.
Runner Player is ending his turn 11 with 8  and 4 cards in his Grip.
Runner Player uses Fencer Fueno to pay 1 .
Runner Player uses Paladin Poemu to trash The Class Act.
Corp Player pays 0  to rez Federal Fundraising in Server 17.
Corp Player pays 1  to rez Balanced Coverage in Server 16.
Corp Player started his turn 12 with 7  and 7 cards in HQ.
Corp Player uses Public Access Plaza to gain 1 .
Corp Player uses Public Access Plaza to gain 1 .
Corp Player uses Federal Fundraising to rearrange the top 3 cards of R&D.
Corp Player declines to use Federal Fundraising to draw 1 card.
Corp Player uses Balanced Coverage to choose ICE.
Corp Player uses Balanced Coverage to reveal Unsmiling Tsarevna from the top of R&D and gain 2 .
Corp Player uses Balanced Coverage to choose ICE.
Corp Player uses Balanced Coverage to reveal Unsmiling Tsarevna from the top of R&D and gain 2 .
Corp Player declines to use Federal Fundraising to draw 1 card.
Corp Player makes his mandatory start of turn draw.
Corp Player spends  and pays 1  to use Corp Basic Action Card to advance a card in Server 13.
Corp Player spends  and pays 1  to use Corp Basic Action Card to advance a card in Server 13.
Corp Player spends  and pays 1  to use Corp Basic Action Card to advance a card in Server 13.
Corp Player uses Wage Workers to gain .
Corp Player scores Embedded Reporting and gains 2 agenda points.
Corp Player spends  and pays 2  to play Oppo Research.
Corp Player uses Oppo Research to give the Runner 2 tags.
Corp Player uses NBN: Reality Plus to gain 2 .
Corp Player pays 5  to use Oppo Research to give the Runner 2 tags.
Corp Player discards 2 cards from HQ at end of turn.
Corp Player is ending his turn 12 with 5  and 5 cards in HQ.
Runner Player started his turn 12 with 7  and 4 cards in his Grip.
Runner Player uses Paladin Poemu to add 1  to itself.
Runner Player uses Fencer Fueno to add 1  to itself.
Runner Player spends  to use Debbie "Downtown" Moreira to make a run on HQ.
Corp Player uses Tiered Subscription to gain 1 .
Corp Player uses Tiered Subscription to gain 1 .
Runner Player approaches Starlit Knight protecting HQ at position 0.
Corp Player has no further action.
Runner Player encounters Starlit Knight protecting HQ at position 0.
Runner Player pays 2  from Debbie "Downtown" Moreira to increase the strength of Revolver to 4.
[!] Runner uses the undo-click command
Runner Player spends  to make a run on Archives.
Corp Player uses Tiered Subscription to gain 1 .
Corp Player uses Tiered Subscription to gain 1 .
Runner Player approaches Archives.
Runner Player uses Pennyshaver to place 1 .
Runner Player breaches Archives.
Runner Player accesses everything else in Archives.
Runner Player spends  and pays 3  from Paladin Poemu to install Curupira.
Runner Player spends  to use Debbie "Downtown" Moreira to make a run on R&D.
Runner Player approaches ice protecting R&D at position 0.
Corp Player pays 2  to rez Ping protecting R&D at position 0.
Corp Player uses Ping to give the Runner 1 tag.
Corp Player uses NBN: Reality Plus to gain 2 .
Runner Player encounters Ping protecting R&D at position 0.
Runner Player uses Curupira to place 1 power counter on itself.
Runner Player pays 1  from Debbie "Downtown" Moreira to use Curupira to break all 1 subroutines on Ping.
Runner Player has no further action.
Runner Player passes Ping protecting R&D at position 0.
Runner Player will continue the run.
Runner Player approaches R&D.
Runner Player uses Pennyshaver to place 1 .
Runner Player breaches R&D.
Runner Player accesses End of the Line from R&D.
Runner Player accesses AMAZE Amusements from the root of R&D.
Runner Player pays 3  from Fencer Fueno to trash AMAZE Amusements from the root of R&D.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player is ending his turn 12 with 7  and 4 cards in his Grip.
Corp Player started his turn 13 with 7  and 5 cards in HQ.
Corp Player uses Public Access Plaza to gain 1 .
Corp Player uses Public Access Plaza to gain 1 .
Corp Player uses Federal Fundraising to rearrange the top 3 cards of R&D.
Corp Player uses Federal Fundraising to draw 1 card.
Corp Player uses Balanced Coverage to choose Operation.
Corp Player uses Balanced Coverage to reveal End of the Line from the top of R&D and gain 2 .
Corp Player uses Balanced Coverage to choose Operation.
Corp Player uses Balanced Coverage to reveal End of the Line from the top of R&D and gain 2 .
Corp Player uses Federal Fundraising to rearrange the top 3 cards of R&D.
Corp Player declines to use Federal Fundraising to draw 1 card.
Corp Player makes his mandatory start of turn draw.
Corp Player spends  to install a card in the root of Server 18 (new remote).
Corp Player scores Freedom of Information and gains 2 agenda points.
Corp Player spends  to install a card in the root of Server 19 (new remote).
Corp Player scores Freedom of Information and gains 2 agenda points.
Corp Player wins the game.`,
  example2: `Corp Player started their turn 1 with 5  and 5 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  and pays 0  to install ice protecting HQ.
Corp Player spends  and pays 0  to install ice protecting R&D.
Corp Player spends  and pays 5  to play Hansei Review.
Corp Player uses Hansei Review to gain 10 .
Corp Player uses Hansei Review to trash a card from HQ.
Corp Player is ending their turn 1 with 10  and 2 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 1 with 5  and 5 cards in his Grip.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  and pays 3  to play Clean Getaway.
Runner Player uses Clean Getaway to make a run on Archives.
Runner Player will continue the run.
Runner Player approaches Archives.
Runner Player uses Clean Getaway to gain 6 .
Runner Player breaches Archives.
Runner Player accesses everything else in Archives.
Runner Player spends  and pays 2  to install Revolver.
Runner Player is ending his turn 1 with 6  and 5 cards in his Grip.
Corp Player started their turn 2 with 11  and 2 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  and pays 0  to play Cultivate.
Corp Player uses Cultivate to look at the top 5 cards of R&D.
Corp Player uses Cultivate to trash a card from among the top 5 cards of R&D, add another one of those cards to HQ, and re-arrange the remainder.
Corp Player spends  and pays 0  to install ice protecting Archives.
Corp Player spends  to use Corp Basic Action Card to draw 1 card.
Corp Player is ending their turn 2 with 11  and 3 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 2 with 6  and 5 cards in his Grip.
Runner Player spends  and pays 5  to play Sure Gamble.
Runner Player uses Sure Gamble to gain 9 .
Runner Player spends  and pays 3  to play Bravado.
Runner Player approaches ice protecting HQ at position 0.
Corp Player pays 6  to rez Attini protecting HQ at position 0.
Runner Player encounters Attini protecting HQ at position 0.
Runner Player indicates to fire all unbroken subroutines on Attini.
Corp Player uses Attini to force the runner to pay 2 .
Corp Player uses Attini to force the runner to pay 2 .
Corp Player uses Attini to force the runner to pay 2 .
Corp Player resolves 3 unbroken subroutines on Attini (" Do 1 net damage unless the Runner pays 2 " and " Do 1 net damage unless the Runner pays 2 " and " Do 1 net damage unless the Runner pays 2 ").
Runner Player has no further action.
Runner Player passes Attini protecting HQ at position 0.
Runner Player will continue the run.
Runner Player approaches HQ.
Runner Player breaches HQ.
Runner Player accesses Esca from HQ.
Corp Player uses Esca to force the Runner to lose 1 .
Runner Player uses Bravado to gain 7 .
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  and pays 1  to install Mystic Maemi.
Runner Player is ending his turn 2 with 6  and 3 cards in his Grip.
Corp Player started their turn 3 with 6  and 3 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  and pays 0  to install ice protecting Server 1 (new remote).
Corp Player spends  to use Corp Basic Action Card to draw 1 card.
Corp Player spends  to use Corp Basic Action Card to draw 1 card.
Corp Player is ending their turn 3 with 6  and 5 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 3 with 6  and 3 cards in his Grip.
Runner Player uses Mystic Maemi to add 1  to itself.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  and pays 1  to install Paladin Poemu.
Runner Player is ending his turn 3 with 5  and 5 cards in his Grip.
Corp Player started their turn 4 with 7  and 5 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  to install a card in the root of Server 1.
Corp Player spends  to use Corp Basic Action Card to draw 1 card.
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player discards 1 card from HQ at end of turn.
Corp Player is ending their turn 4 with 8  and 5 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 4 with 5  and 5 cards in his Grip.
Runner Player uses Mystic Maemi to add 1  to itself.
Runner Player uses Paladin Poemu to add 1  to itself.
Runner Player spends  and pays 2  from Mystic Maemi and 3  from his credit pool to play Sure Gamble.
Runner Player uses Sure Gamble to gain 9 .
Runner Player spends  and pays 1  from Paladin Poemu and 2  from his credit pool to install Curupira.
Runner Player spends  to make a run on Archives.
Runner Player approaches ice protecting Archives at position 0.
Corp Player pays 2  to rez Tatu-Bola protecting Archives at position 0.
Runner Player encounters Tatu-Bola protecting Archives at position 0.
Runner Player uses Curupira to place 1 power counter on itself.
Runner Player pays 1  to use Curupira to break all 1 subroutines on Tatu-Bola.
Runner Player has no further action.
Runner Player passes Tatu-Bola protecting Archives at position 0.
Corp Player uses Tatu-Bola to swap Tatu-Bola protecting Archives at position 0 with a piece of ice from HQ and gain 4 .
Runner Player approaches Archives.
Runner Player breaches Archives.
Runner Player accesses Esca from Archives.
Corp Player uses Esca to force the Runner to lose 1 .
Runner Player accesses Esca from Archives.
Corp Player uses Esca to force the Runner to lose 1 .
Runner Player accesses everything else in Archives.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player is ending his turn 4 with 6  and 4 cards in his Grip.
Corp Player started their turn 5 with 11  and 5 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  to install a card in the root of Server 2 (new remote).
Corp Player pays 0  to rez Spin Doctor in Server 2.
Corp Player uses Spin Doctor to draw 2 cards.
Corp Player spends  and pays 1  to install ice protecting Archives.
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player discards 1 card from HQ at end of turn.
Corp Player is ending their turn 5 with 11  and 5 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 5 with 6  and 4 cards in his Grip.
Runner Player uses Mystic Maemi to add 1  to itself.
Runner Player uses Paladin Poemu to add 1  to itself.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  and pays 1  from Paladin Poemu to install Docklands Pass.
Runner Player spends  to use Runner Basic Action Card to gain 1 .
Runner Player is ending his turn 5 with 7  and 5 cards in his Grip.
Corp Player started their turn 6 with 12  and 5 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  and pays 1  to use Corp Basic Action Card to advance a card in Server 1.
Corp Player spends  and pays 1  to use Corp Basic Action Card to advance a card in Server 1.
Corp Player spends  and pays 1  to use Corp Basic Action Card to advance a card in Server 1.
Corp Player scores Regenesis and gains 1 agenda point.
Corp Player uses Regenesis to reveal Fujii Asset Retrieval and add it to their score area.
Corp Player discards 1 card from HQ at end of turn.
Corp Player is ending their turn 6 with 9  and 5 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 6 with 7  and 5 cards in his Grip.
Runner Player uses Mystic Maemi to add 1  to itself.
Runner Player uses Paladin Poemu to add 1  to itself.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  and pays 1  from Paladin Poemu and 2  from his credit pool to install Unity.
Runner Player spends  to use Runner Basic Action Card to gain 1 .
Runner Player discards Pinhole Threading from his Grip at end of turn.
Runner Player is ending his turn 6 with 6  and 5 cards in his Grip.
Corp Player started their turn 7 with 10  and 5 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  to install a card in the root of Server 1.
Corp Player spends  and pays 1  to use Corp Basic Action Card to advance a card in Server 1.
Corp Player spends  and pays 1  to install ice protecting HQ.
Corp Player is ending their turn 7 with 8  and 4 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 7 with 6  and 5 cards in his Grip.
Runner Player uses Mystic Maemi to add 1  to itself.
Runner Player uses Paladin Poemu to add 1  to itself.
Runner Player spends  and pays 3  from Mystic Maemi to play Bravado.
Runner Player approaches ice protecting R&D at position 0.
Corp Player pays 4  to rez Phoneutria protecting R&D at position 0.
Corp Player has no further action.
Runner Player encounters Phoneutria protecting R&D at position 0.
Runner Player pays 2  and spends 2 hosted power counters from on Revolver to increase the strength of Revolver to 4 and break all 2 subroutines on Phoneutria.
Runner Player has no further action.
Runner Player passes Phoneutria protecting R&D at position 0.
Corp Player uses Phoneutria to give the Runner 1 tag.
Runner Player will continue the run.
Runner Player approaches R&D.
Runner Player breaches R&D.
Runner Player accesses Cultivate from R&D.
Runner Player uses Bravado to gain 7 .
Runner Player spends  and pays 0  to play Transfer of Wealth.
Runner Player uses Transfer of Wealth to make a run on HQ.
Corp Player pays 0  to rez Charlotte Caçador in Server 1.
Corp Player spends 1 hosted advancement counter from on Charlotte Caçador and trashes Charlotte Caçador to use Charlotte Caçador to gain 3 .
Runner Player approaches ice protecting HQ at position 1.
Corp Player pays 7  to rez Empiricist protecting HQ at position 1.
Corp Player has no further action.
Runner Player encounters Empiricist protecting HQ at position 1.
Runner Player pays 4  to increase the strength of Revolver to 7.
Runner Player spends 1 hosted power counter from on Revolver to use Revolver to break 1 Sentry subroutine on Empiricist (" Do 1 net damage and give the Runner 1 tag").
Runner Player spends 1 hosted power counter from on Revolver to use Revolver to break 1 Sentry subroutine on Empiricist (" Do 2 net damage").
Runner Player indicates to fire all unbroken subroutines on Empiricist.
Corp Player uses Empiricist to draw 1 card.
Corp Player uses Empiricist to add 1 card in HQ to the top of R&D.
Corp Player resolves 1 unbroken subroutine on Empiricist (" Draw 1 card. You may add 1 card from HQ to the top of R&D.").
Runner Player passes Empiricist protecting HQ at position 1.
Runner Player jacks out.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  and pays 2  to use Runner Basic Action Card to remove 1 tag.
Runner Player is ending his turn 7 with 5  and 4 cards in his Grip.
Corp Player started their turn 8 with 1  and 4 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  to install a card in the root of Server 1.
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player is ending their turn 8 with 3  and 4 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 8 with 5  and 4 cards in his Grip.
Runner Player uses Mystic Maemi to add 1  to itself.
Runner Player uses Paladin Poemu to add 1  to itself.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  and pays 1  from Paladin Poemu to install Cupellation.
Runner Player spends  and pays 1  from Mystic Maemi and 2  from his credit pool to play Bravado.
Runner Player approaches ice protecting Server 1 at position 0.
Corp Player has no further action.
Runner Player passes ice protecting Server 1 at position 0.
Runner Player approaches Server 1.
Runner Player breaches Server 1.
Runner Player accesses Regolith Mining License from Server 1.
Runner Player pays 3  to trash Regolith Mining License from Server 1.
Runner Player uses Bravado to gain 7 .
Runner Player spends  to use Runner Basic Action Card to gain 1 .
Runner Player is ending his turn 8 with 8  and 3 cards in his Grip.
Corp Player started their turn 9 with 4  and 4 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  and pays 0  to play Cultivate.
Corp Player uses Cultivate to look at the top 5 cards of R&D.
Corp Player uses Cultivate to trash a card from among the top 5 cards of R&D, add another one of those cards to HQ, and re-arrange the remainder.
Corp Player spends  and pays 1  to install ice protecting Server 1.
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player is ending their turn 9 with 4  and 4 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 9 with 8  and 3 cards in his Grip.
Runner Player uses Mystic Maemi to add 1  to itself.
Runner Player uses Paladin Poemu to add 1  to itself.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  and pays 1  from Paladin Poemu to install Side Hustle.
Runner Player is ending his turn 9 with 8  and 5 cards in his Grip.
Corp Player started their turn 10 with 5  and 4 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  and pays 2  to install ice protecting HQ.
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player is ending their turn 10 with 5  and 4 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 10 with 8  and 5 cards in his Grip.
Runner Player uses Mystic Maemi to add 1  to itself.
Runner Player uses Paladin Poemu to add 1  to itself.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  and pays 2  from Paladin Poemu to install Pennyshaver.
Runner Player spends  and pays 2  to install Cezve.
! Cezve - Recurring credits usage not restricted
Runner Player is ending his turn 10 with 6  and 5 cards in his Grip.
Corp Player started their turn 11 with 6  and 4 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  and pays 1  to install ice protecting R&D.
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player is ending their turn 11 with 7  and 4 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 11 with 6  and 5 cards in his Grip.
Runner Player uses Mystic Maemi to add 1  to itself.
Runner Player uses Paladin Poemu to add 1  to itself.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  to make a run on Server 2.
Corp Player uses Spin Doctor to shuffle Regolith Mining License and 1 unseen card into R&D.
Runner Player spends  and pays 3  from Mystic Maemi and 2  from his credit pool to play Sure Gamble.
Runner Player uses Sure Gamble to gain 9 .
Runner Player spends  and pays 3  to install The Class Act.
Runner Player is ending his turn 11 with 10  and 4 cards in his Grip.
Runner Player uses The Class Act to draw 4 cards.
Corp Player started their turn 12 with 8  and 4 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  to use Corp Basic Action Card to draw 1 card.
Corp Player spends  to install a card in the root of Server 1.
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player is ending their turn 12 with 9  and 5 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 12 with 10  and 8 cards in his Grip.
Runner Player uses Mystic Maemi to add 1  to itself.
Runner Player uses Paladin Poemu to add 1  to itself.
Runner Player spends  and pays 1  from Paladin Poemu to install Side Hustle.
Runner Player uses Paladin Poemu to take 1 .
Runner Player spends  and pays 1  from Mystic Maemi and 2  from his credit pool to play Clean Getaway.
Runner Player uses Clean Getaway to make a run on R&D.
Runner Player approaches ice protecting R&D at position 1.
Runner Player passes ice protecting R&D at position 1.
Runner Player approaches Phoneutria protecting R&D at position 0.
Corp Player has no further action.
Runner Player encounters Phoneutria protecting R&D at position 0.
Runner Player pays 2  from Cezve and spends 2 hosted power counters from on Revolver to increase the strength of Revolver to 4 and break all 2 subroutines on Phoneutria.
Runner Player has no further action.
Runner Player passes Phoneutria protecting R&D at position 0.
Corp Player uses Phoneutria to give the Runner 1 tag.
Runner Player will continue the run.
Runner Player approaches R&D.
Runner Player uses Clean Getaway to gain 6 .
Runner Player uses Pennyshaver to place 1 .
Runner Player breaches R&D.
Runner Player accesses Tatu-Bola from R&D.
Runner Player spends  and pays 3  to install Carmen.
Runner Player spends  and pays 2  to use Runner Basic Action Card to remove 1 tag.
Runner Player is ending his turn 12 with 10  and 5 cards in his Grip.
Corp Player started their turn 13 with 10  and 5 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  to use Corp Basic Action Card to draw 1 card.
Corp Player spends  to install a card in the root of Server 1.
Corp Player trashes a card in Server 1.
Corp Player spends  and pays 1  to use Corp Basic Action Card to advance a card in Server 1.
Corp Player discards 1 card from HQ at end of turn.
Corp Player is ending their turn 13 with 9  and 5 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 13 with 10  and 5 cards in his Grip.
Runner Player uses Mystic Maemi to add 1  to itself.
Runner Player uses Paladin Poemu to add 1  to itself.
Runner Player spends  and pays 1  from Mystic Maemi to play Pinhole Threading.
Runner Player uses Pinhole Threading to make a run on Archives.
Runner Player approaches ice protecting Archives at position 1.
Runner Player passes ice protecting Archives at position 1.
Runner Player approaches ice protecting Archives at position 0.
Corp Player pays 6  to rez Attini protecting Archives at position 0.
Corp Player has no further action.
Runner Player encounters Attini protecting Archives at position 0.
Runner Player pays 2  from Cezve and 3  from his credit pool to increase the strength of Unity to 7 and break all 3 subroutines on Attini.
Runner Player has no further action.
Runner Player passes Attini protecting Archives at position 0.
Runner Player will continue the run.
Corp Player pays 0  to rez Charlotte Caçador in Server 1.
Corp Player spends 1 hosted advancement counter from on Charlotte Caçador and trashes Charlotte Caçador to use Charlotte Caçador to gain 3 .
Runner Player approaches Archives.
Runner Player uses Pennyshaver to place 1 .
Runner Player uses the replacement effect from Pinhole Threading.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player uses The Class Act to add the second card on the top of the stack (Touchstone) to the bottom.
Runner Player spends  to use Pennyshaver to gain 3 .
Runner Player spends  and pays 1  from Paladin Poemu to install Open Market.
Runner Player is ending his turn 13 with 10  and 4 cards in his Grip.
Corp Player started their turn 14 with 7  and 5 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  to install a card in the root of Server 1.
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player is ending their turn 14 with 9  and 5 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 14 with 10  and 4 cards in his Grip.
Runner Player uses Mystic Maemi to add 1  to itself.
Runner Player uses Paladin Poemu to add 1  to itself.
Runner Player uses Open Market to gain 1 .
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player uses The Class Act to add the first card on the top of the stack (Pennyshaver) to the bottom.
Runner Player spends  to make a run on R&D.
Runner Player approaches ice protecting R&D at position 1.
Corp Player has no further action.
Runner Player passes ice protecting R&D at position 1.
Runner Player jacks out.
Runner Player spends  and pays 0  to play Transfer of Wealth.
Runner Player uses Transfer of Wealth to make a run on HQ.
Runner Player uses Side Hustle to gain 6 , draw 1 card, and trash itself.
Runner Player approaches ice protecting HQ at position 2.
Corp Player pays 6  to rez Boto protecting HQ at position 2.
Corp Player has no further action.
Runner Player encounters Boto protecting HQ at position 2.
Runner Player uses Curupira to place 1 power counter on itself.
Runner Player pays 2  from Cezve and 6  from his credit pool to increase the strength of Curupira to 6 and break all 3 subroutines on Boto.
Runner Player has no further action.
Runner Player passes Boto protecting HQ at position 2.
Runner Player approaches Empiricist protecting HQ at position 1.
Corp Player has no further action.
Runner Player encounters Empiricist protecting HQ at position 1.
Runner Player pays 5  to increase the strength of Carmen to 5 and break all 3 subroutines on Empiricist.
Runner Player has no further action.
Runner Player passes Empiricist protecting HQ at position 1.
Runner Player approaches Attini protecting HQ at position 0.
Runner Player encounters Attini protecting HQ at position 0.
Runner Player pays 5  to increase the strength of Unity to 7 and break all 3 subroutines on Attini.
Runner Player has no further action.
Runner Player passes Attini protecting HQ at position 0.
Runner Player will continue the run.
Corp Player pays 3  to rez La Costa Grid in Server 1.
Runner Player approaches HQ.
Runner Player uses Transfer of Wealth to take 1 tagand force the Corp to lose 1 , and then gain 2 .
Runner Player uses Pennyshaver to place 1 .
Runner Player breaches HQ.
Runner Player uses Docklands Pass to access 1 additional card from HQ.
Runner Player accesses Fujii Asset Retrieval from HQ.
Runner Player steals Fujii Asset Retrieval and gains 3 agenda points.
Runner Player uses Mystic Maemi to add 1  to itself.
Runner Player uses Paladin Poemu to add 1  to itself.
Corp Player uses Fujii Asset Retrieval to do 2 net damage.
Corp Player trashes Curupira and Pennyshaver due to net damage.
Runner Player accesses Tatu-Bola from HQ.
Runner Player pays 1  to use Cupellation to host Tatu-Bola on itself.
Runner Player spends  and pays 2  to use Runner Basic Action Card to remove 1 tag.
Runner Player is ending his turn 14 with 0  and 3 cards in his Grip.
Corp Player started their turn 15 with 0  and 3 cards in HQ.
Corp Player uses La Costa Grid to place 1 advancement counter on La Costa Grid in Server 1.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  to install a card in the root of Server 1.
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player spends  and pays 1  to use Corp Basic Action Card to advance a card in Server 1.
Corp Player is ending their turn 15 with 0  and 3 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 15 with 0  and 3 cards in his Grip.
Runner Player uses Mystic Maemi to add 1  to itself.
Runner Player uses Paladin Poemu to add 1  to itself.
Runner Player uses Open Market to gain 1 .
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player uses The Class Act to add the first card on the top of the stack (Cezve) to the bottom.
Runner Player spends  to make a run on Server 1.
Runner Player uses Side Hustle to gain 6 , draw 1 card, and trash itself.
Runner Player approaches ice protecting Server 1 at position 1.
Runner Player passes ice protecting Server 1 at position 1.
Runner Player will continue the run.
Runner Player approaches ice protecting Server 1 at position 0.
Corp Player has no further action.
Runner Player passes ice protecting Server 1 at position 0.
Runner Player will continue the run.
Corp Player pays 0  to rez Charlotte Caçador in Server 1.
Corp Player spends 1 hosted advancement counter from on Charlotte Caçador and trashes Charlotte Caçador to use Charlotte Caçador to gain 3 .
Runner Player approaches Server 1.
Runner Player uses Pennyshaver to place 1 .
Runner Player breaches Server 1.
Runner Player accesses La Costa Grid from Server 1.
Runner Player spends  and pays 1  from Paladin Poemu to install Side Hustle.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player is ending his turn 15 with 7  and 5 cards in his Grip.
Runner Player uses Mystic Maemi to trash itself.
Corp Player started their turn 16 with 4  and 3 cards in HQ.
Corp Player uses La Costa Grid to place 1 advancement counter on La Costa Grid in Server 1.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  to install a card in the root of Server 1.
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player is ending their turn 16 with 6  and 3 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 16 with 7  and 5 cards in his Grip.
Runner Player uses Paladin Poemu to add 1  to itself.
Runner Player uses Open Market to gain 1 .
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player uses The Class Act to add the second card on the top of the stack (Dr. Nuka Vrolyck) to the bottom.
Runner Player spends  and pays 0  to install Debbie "Downtown" Moreira.
Runner Player uses Debbie "Downtown" Moreira to place 2  on itself.
Runner Player spends  to use Debbie "Downtown" Moreira to make a run on Server 1.
Runner Player approaches ice protecting Server 1 at position 1.
Corp Player pays 6  to rez Attini protecting Server 1 at position 1.
Runner Player encounters Attini protecting Server 1 at position 1.
Runner Player pays 2  from Debbie "Downtown" Moreira and 3  from his credit pool to increase the strength of Unity to 7 and break all 3 subroutines on Attini.
Runner Player passes Attini protecting Server 1 at position 1.
Runner Player approaches ice protecting Server 1 at position 0.
Runner Player passes ice protecting Server 1 at position 0.
Runner Player will continue the run.
Runner Player approaches Server 1.
Runner Player uses Pennyshaver to place 1 .
Runner Player breaches Server 1.
Runner Player accesses Let Them Dream from Server 1.
Runner Player steals Let Them Dream and gains 1 agenda point.
Runner Player uses Paladin Poemu to add 1  to itself.
Runner Player accesses La Costa Grid from Server 1.
Runner Player pays 4  to trash La Costa Grid from Server 1.
Runner Player spends  and pays 1  from Open Market to install Dr. Nuka Vrolyck.
Runner Player is ending his turn 16 with 1  and 4 cards in his Grip.
Runner Player uses Paladin Poemu to trash Debbie "Downtown" Moreira.
Corp Player started their turn 17 with 1  and 3 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  to install a card in the root of Server 1.
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player is ending their turn 17 with 3  and 3 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 17 with 1  and 4 cards in his Grip.
Runner Player uses Paladin Poemu to add 1  to itself.
Runner Player uses Open Market to gain 1 .
Runner Player spends  and spends 1 hosted power counter from on Dr. Nuka Vrolyck to use Dr. Nuka Vrolyck to draw 3 cards.
Runner Player uses The Class Act to add the third card on the top of the stack (Shibboleth) to the bottom.
Runner Player spends  to make a run on R&D.
Runner Player approaches ice protecting R&D at position 1.
Runner Player passes ice protecting R&D at position 1.
Runner Player approaches Phoneutria protecting R&D at position 0.
Corp Player has no further action.
Runner Player encounters Phoneutria protecting R&D at position 0.
Runner Player pays 2  from Cezve to use Carmen to break all 2 subroutines on Phoneutria.
Runner Player has no further action.
Runner Player passes Phoneutria protecting R&D at position 0.
Corp Player uses Phoneutria to give the Runner 1 tag.
Runner Player will continue the run.
Corp Player pays 0  to rez Spin Doctor in Server 1.
Corp Player uses Spin Doctor to draw 2 cards.
Corp Player uses Spin Doctor to shuffle Esca and Esca into R&D.
Runner Player approaches R&D.
Runner Player uses Pennyshaver to place 1 .
Runner Player breaches R&D.
Runner Player accesses Cloud Eater from R&D.
Runner Player spends  to use Pennyshaver to gain 5 .
Runner Player spends  to use Runner Basic Action Card to gain 1 .
Runner Player discards Zenit Chip JZ-2MJ and Zenit Chip JZ-2MJ from his Grip at end of turn.
Runner Player is ending his turn 17 with 8  and 5 cards in his Grip.
Runner Player uses Paladin Poemu to trash Paladin Poemu.
Corp Player started their turn 18 with 4  and 5 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  to install a card in the root of Server 1.
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player is ending their turn 18 with 6  and 5 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 18 with 8  and 5 cards in his Grip.
Runner Player uses Open Market to gain 1 .
Runner Player trashes Open Market.
Runner Player trashes Dr. Nuka Vrolyck.
Runner Player spends  and spends 1 hosted power counter from on Dr. Nuka Vrolyck to use Dr. Nuka Vrolyck to draw 3 cards.
Runner Player uses The Class Act to add the fourth card on the top of the stack (Pennyshaver) to the bottom.
Runner Player spends  and pays 3  to play Clean Getaway.
Runner Player uses Clean Getaway to make a run on R&D.
Runner Player approaches ice protecting R&D at position 1.
Corp Player pays 6  to rez Lionsmane protecting R&D at position 1.
Runner Player encounters Lionsmane protecting R&D at position 1.
Runner Player pays 2  from Cezve and 3  from his credit pool to increase the strength of Carmen to 5 and break all 3 subroutines on Lionsmane.
Runner Player has no further action.
Runner Player passes Lionsmane protecting R&D at position 1.
Runner Player approaches Phoneutria protecting R&D at position 0.
Corp Player has no further action.
Runner Player encounters Phoneutria protecting R&D at position 0.
Runner Player indicates to fire all unbroken subroutines on Phoneutria.
Corp Player uses Phoneutria to do 1 net damage.
Corp Player trashes The Class Act due to net damage.
Corp Player uses Phoneutria to do 1 net damage.
Corp Player trashes Fencer Fueno due to net damage.
Corp Player resolves 2 unbroken subroutines on Phoneutria (" Do 1 net damage" and " Do 1 net damage").
Runner Player passes Phoneutria protecting R&D at position 0.
Corp Player uses Phoneutria to give the Runner 1 tag.
Runner Player approaches R&D.
Runner Player uses Clean Getaway to gain 6 .
Runner Player uses Pennyshaver to place 1 .
Runner Player breaches R&D.
Runner Player accesses Empiricist from R&D.
Runner Player spends  to make a run on Server 1.
Runner Player approaches Attini protecting Server 1 at position 1.
Corp Player has no further action.
Runner Player encounters Attini protecting Server 1 at position 1.
Runner Player indicates to fire all unbroken subroutines on Attini.
Corp Player trashes T400 Memory Diamond due to net damage.
Corp Player trashes Hackerspace due to net damage.
Corp Player trashes Touchstone due to net damage.
Corp Player resolves 3 unbroken subroutines on Attini (" Do 1 net damage unless the Runner pays 2 " and " Do 1 net damage unless the Runner pays 2 " and " Do 1 net damage unless the Runner pays 2 ").
Runner Player passes Attini protecting Server 1 at position 1.
Runner Player approaches ice protecting Server 1 at position 0.
Runner Player passes ice protecting Server 1 at position 0.
Runner Player approaches Server 1.
Runner Player uses Pennyshaver to place 1 .
Runner Player breaches Server 1.
Runner Player accesses La Costa Grid from Server 1.
Runner Player pays 4  to trash La Costa Grid from Server 1.
Runner Player spends  to use Pennyshaver to gain 3 .
Runner Player is ending his turn 18 with 8  and 2 cards in his Grip.
Corp Player started their turn 19 with 1  and 5 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  to install a card in the root of Server 1.
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player is ending their turn 19 with 3  and 5 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 19 with 8  and 2 cards in his Grip.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player uses The Class Act to add the second card on the top of the stack (Dr. Nuka Vrolyck) to the bottom.
Runner Player spends  to use Runner Basic Action Card to gain 1 .
Runner Player spends  to use Runner Basic Action Card to gain 1 .
Runner Player spends  and pays 0  to play Transfer of Wealth.
Runner Player uses Transfer of Wealth to make a run on HQ.
Runner Player uses Side Hustle to gain 6 , draw 1 card, and trash itself.
Runner Player approaches Boto protecting HQ at position 2.
Corp Player has no further action.
Runner Player encounters Boto protecting HQ at position 2.
Runner Player uses Curupira to place 1 power counter on itself.
Runner Player pays 2  from Cezve and 6  from his credit pool to increase the strength of Curupira to 6 and break all 3 subroutines on Boto.
Runner Player passes Boto protecting HQ at position 2.
Runner Player will continue the run.
Runner Player approaches Empiricist protecting HQ at position 1.
Corp Player has no further action.
Runner Player encounters Empiricist protecting HQ at position 1.
Runner Player pays 2  to increase the strength of Unity to 7.
Runner Player sets credit to 9 (+1).
Runner Player sets credit to 10 (+1).
Runner Player pays 5  to increase the strength of Carmen to 5 and break all 3 subroutines on Empiricist.
Runner Player passes Empiricist protecting HQ at position 1.
Runner Player will continue the run.
Runner Player approaches Attini protecting HQ at position 0.
Runner Player encounters Attini protecting HQ at position 0.
Runner Player pays 2  to increase the strength of Unity to 7.
Runner Player pays 1  to use Unity to break 1 Code Gate subroutine on Attini (" Do 1 net damage unless the Runner pays 2 ").
Runner Player pays 1  to use Unity to break 1 Code Gate subroutine on Attini (" Do 1 net damage unless the Runner pays 2 ").
Runner Player pays 1  to use Unity to break 1 Code Gate subroutine on Attini (" Do 1 net damage unless the Runner pays 2 ").
Runner Player has no further action.
Runner Player passes Attini protecting HQ at position 0.
Runner Player will continue the run.
Runner Player approaches HQ.
Runner Player uses Transfer of Wealth to take 1 tagand force the Corp to lose 3 , and then gain 6 .
Runner Player uses Pennyshaver to place 1 .
Runner Player breaches HQ.
Runner Player uses Docklands Pass to access 1 additional card from HQ.
Cupellation has left play: Tatu-Bola is trashed.
Runner Player pays 1  and trashes Cupellation to use Cupellation to access 2 additional cards from HQ.
Runner Player accesses Cloud Eater from HQ.
Runner Player accesses Tatu-Bola from HQ.
Runner Player accesses Empiricist from HQ.
Runner Player accesses Measured Response from HQ.
Runner Player pays 3  to trash Measured Response from HQ.
Runner Player is ending his turn 19 with 2  and 3 cards in his Grip.
Corp Player started their turn 20 with 1  and 4 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  and pays 1  to use Corp Basic Action Card to advance a card in Server 1.
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player is ending their turn 20 with 2  and 5 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 20 with 2  and 3 cards in his Grip.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player uses The Class Act to add the second card on the top of the stack (Dr. Nuka Vrolyck) to the bottom.
Runner Player spends  to use Pennyshaver to gain 2 .
Runner Player spends  to use Runner Basic Action Card to gain 1 .
Runner Player spends  to use Runner Basic Action Card to gain 1 .
Runner Player is ending his turn 20 with 6  and 4 cards in his Grip.
Corp Player started their turn 21 with 3  and 5 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player spends  and pays 5  to play Hedge Fund.
Corp Player uses Hedge Fund to gain 9 .
Corp Player is ending their turn 21 with 9  and 5 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 21 with 6  and 4 cards in his Grip.
Runner Player spends  and pays 2  to install Cezve.
! Cezve - Recurring credits usage not restricted
Runner Player spends  to make a run on R&D.
Runner Player approaches Lionsmane protecting R&D at position 1.
Corp Player has no further action.
Runner Player encounters Lionsmane protecting R&D at position 1.
Runner Player pays 2  from Cezve and 2  from Cezve and 1  from his credit pool to increase the strength of Carmen to 5 and break all 3 subroutines on Lionsmane.
Runner Player has no further action.
Runner Player passes Lionsmane protecting R&D at position 1.
Runner Player approaches Phoneutria protecting R&D at position 0.
Corp Player has no further action.
Runner Player encounters Phoneutria protecting R&D at position 0.
Runner Player pays 2  to use Carmen to break all 2 subroutines on Phoneutria.
Runner Player has no further action.
Runner Player passes Phoneutria protecting R&D at position 0.
Runner Player approaches R&D.
Runner Player uses Pennyshaver to place 1 .
Runner Player breaches R&D.
Runner Player accesses Sisyphus Protocol from R&D.
Runner Player steals Sisyphus Protocol and gains 2 agenda points.
Runner Player spends  to use Runner Basic Action Card to draw 1 card.
Runner Player spends  to use Pennyshaver to gain 2 .
Runner Player is ending his turn 21 with 3  and 4 cards in his Grip.
Corp Player started their turn 22 with 10  and 5 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  and pays 1  to use Corp Basic Action Card to advance a card in Server 1.
Corp Player spends  and pays 1  to use Corp Basic Action Card to advance a card in Server 1.
Corp Player spends  and pays 1  to use Corp Basic Action Card to advance a card in Server 1.
Corp Player scores Let Them Dream and gains 2 agenda points.
Corp Player uses Let Them Dream to reveal Fujii Asset Retrieval from Archives and add it to HQ.
Corp Player discards 2 cards from HQ at end of turn.
Corp Player is ending their turn 22 with 7  and 5 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 22 with 3  and 4 cards in his Grip.
Runner Player spends  to use Runner Basic Action Card to gain 1 .
Runner Player spends  to use Runner Basic Action Card to gain 1 .
Runner Player spends  to use Runner Basic Action Card to gain 1 .
Runner Player spends  to use Runner Basic Action Card to gain 1 .
Runner Player is ending his turn 22 with 7  and 4 cards in his Grip.
Corp Player started their turn 23 with 8  and 5 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  and pays 5  to play Hansei Review.
Corp Player uses Hansei Review to gain 10 .
Corp Player uses Hansei Review to trash a card from HQ.
Corp Player spends  to install a card in the root of Server 1.
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player is ending their turn 23 with 14  and 3 cards in HQ.
Corp Player uses Jinteki: Restoring Humanity to gain 1 .
Runner Player started his turn 23 with 7  and 4 cards in his Grip.
Runner Player spends  to make a run on Archives.
Runner Player approaches ice protecting Archives at position 1.
Runner Player passes ice protecting Archives at position 1.
Runner Player approaches Attini protecting Archives at position 0.
Corp Player has no further action.
Runner Player encounters Attini protecting Archives at position 0.
Runner Player pays 2  from Cezve and 2  from Cezve and 1  from his credit pool to increase the strength of Unity to 7 and break all 3 subroutines on Attini.
Runner Player has no further action.
Runner Player passes Attini protecting Archives at position 0.
Runner Player will continue the run.
Corp Player pays 0  to rez Spin Doctor in Server 1.
Corp Player uses Spin Doctor to draw 2 cards.
Corp Player uses Spin Doctor to shuffle Cultivate and 1 unseen card into R&D.
Runner Player approaches Archives.
Runner Player uses Pennyshaver to place 1 .
Runner Player breaches Archives.
Runner Player accesses Esca from Archives.
Corp Player uses Esca to force the Runner to lose 1 .
Corp Player uses Esca to do 1 net damage.
Corp Player trashes Pennyshaver due to net damage.
Runner Player accesses everything else in Archives.
Runner Player spends  to use Pennyshaver to gain 2 .
Runner Player spends  to use Runner Basic Action Card to gain 1 .
Runner Player spends  to use Runner Basic Action Card to gain 1 .
Runner Player is ending his turn 23 with 9  and 3 cards in his Grip.
Corp Player started their turn 24 with 15  and 5 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  to install a card in the root of Server 1.
Corp Player spends  and pays 5  to play Measured Response.
Runner Player pays 8  to satisfy Measured Response.
Corp Player spends  to use Corp Basic Action Card to gain 1 .
Corp Player is ending their turn 24 with 11  and 4 cards in HQ.
Runner Player started his turn 24 with 1  and 3 cards in his Grip.
Runner Player spends  to use Runner Basic Action Card to gain 1 .
Runner Player spends  to use Runner Basic Action Card to gain 1 .
Runner Player spends  to make a run on R&D.
Corp Player has no further action.
Runner Player approaches Lionsmane protecting R&D at position 1.
Runner Player encounters Lionsmane protecting R&D at position 1.
Runner Player pays 2  from Cezve and 2  from Cezve and 1  from his credit pool to increase the strength of Carmen to 5 and break all 3 subroutines on Lionsmane.
Runner Player passes Lionsmane protecting R&D at position 1.
Corp Player has no further action.
Runner Player approaches Phoneutria protecting R&D at position 0.
Runner Player encounters Phoneutria protecting R&D at position 0.
Runner Player pays 2  to use Carmen to break all 2 subroutines on Phoneutria.
Runner Player passes Phoneutria protecting R&D at position 0.
Runner Player will continue the run.
Runner Player approaches R&D.
Runner Player uses Pennyshaver to place 1 .
Runner Player breaches R&D.
Runner Player accesses Esca from R&D.
Runner Player must reveal they accessed Esca.
Corp Player uses Esca to force the Runner to lose 1 .
Corp Player uses Esca to do 1 net damage.
Corp Player trashes Dr. Nuka Vrolyck due to net damage.
Runner Player spends  to use Pennyshaver to gain 2 .
Runner Player is ending his turn 24 with 2  and 2 cards in his Grip.
Corp Player started their turn 25 with 11  and 4 cards in HQ.
Corp Player makes their mandatory start of turn draw.
Corp Player spends  and pays 1  to use Corp Basic Action Card to advance a card in Server 1.
Corp Player spends  and pays 1  to use Corp Basic Action Card to advance a card in Server 1.
Corp Player spends  and pays 1  to use Corp Basic Action Card to advance a card in Server 1.
Corp Player scores Regenesis and gains 1 agenda point.
Corp Player wins the game.`
};
