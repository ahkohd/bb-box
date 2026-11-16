# Linux cursor evidence

The production SelkiesSession and SelkiesRelay run in an isolated harness against a real Xfce/X11 desktop stream. The harness supplies explicit action roles through AgentShapes and invokes the existing video cursor switch. This is not a recording of the complete BB application.

The hand, text cursor and arrow overlays render. Clearing the overlay restores the box pointer. A stale native cursor can remain elsewhere in an already open stream after the cursor switch; a fresh stream clears it. These captures therefore do not prove the requested one-pointer invariant. Full Box panel acceptance recording remains outstanding.

The recording includes an initial arrow action and a wait for capture reconfiguration, followed by the link, field, text, arrow and clear actions. The stills include the residual small arrow below the field. The test harness is supplied beside the captures.
