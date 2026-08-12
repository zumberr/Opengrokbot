# Native Windows speech-to-text helper using .NET System.Speech
# Streams NDJSON lines to stdout:
#   {"partial":true,"text":"…"}   while recognizing
#   {"partial":false,"text":"…"}  final result
#   {"error":"…"}                 on error

Add-Type -AssemblyName System.Speech
try {
    $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine
    $recognizer.SetInputToDefaultAudioDevice()
    $grammar = New-Object System.Speech.Recognition.DictationGrammar
    $recognizer.LoadGrammar($grammar)

    # Handle partial results (hypotheses)
    $hypoEvent = Register-ObjectEvent $recognizer SpeechHypothesized -Action {
        $text = $Event.SourceEventArgs.Result.Text
        $json = @{ partial = $true; text = $text } | ConvertTo-Json -Compress
        [Console]::Out.WriteLine($json)
        [Console]::Out.Flush()
    }

    # Handle final results
    $recEvent = Register-ObjectEvent $recognizer SpeechRecognized -Action {
        $text = $Event.SourceEventArgs.Result.Text
        $json = @{ partial = $false; text = $text } | ConvertTo-Json -Compress
        [Console]::Out.WriteLine($json)
        [Console]::Out.Flush()
    }

    $recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)

    # Keep the script alive and process events
    while ($true) {
        Wait-Event -Timeout 1 > $null
    }
} catch {
    $err = $_.Exception.Message
    $json = @{ error = $err } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
    exit 1
} finally {
    if ($recognizer) {
        $recognizer.RecognizeAsyncStop()
        $recognizer.Dispose()
    }
}
