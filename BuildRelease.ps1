
function pause() {
    Write-Host "Press any key to continue ..."
    cmd /c pause | out-null
}

function MsBuild([string] $srcDir, [string] $solutionFileName) {
    $msBuild = "C:\Windows\Microsoft.NET\Framework\v4.0.30319\MSBuild.exe"
    cd $srcDir

    # create the build command and invoke it 
    # note that if you want to debug, remove the "/noconsolelogger" 
    # from the $options string
    # $options = "/noconsolelogger /p:Configuration=Release 
    $options = "/p:Configuration=Release /verbosity:normal"

    $clean = $msbuild + " `"$solutionFileName`" " + $options + " /t:Clean"
    $build = $msbuild + " `"$solutionFileName`" " + $options + " /t:reBuild"
    Write-Host "Cleaning $solutionFileName..."
    $x = Invoke-Expression $clean

    Write-Host "Building $solutionFileName..."
    $output = Invoke-Expression $build    

    if (($output | Select-string "Build succeeded" ) -ne $null) {
        Write-Host "Build succeeded - $solutionFileName"
    } else {
        $output | out-string
        Write-Host "Build failed - $solutionFileName"
        pause
    }    
}

$srcDir = Split-Path -Path $MyInvocation.MyCommand.Definition -Parent
MsBuild $srcDir "Breeze.Build.sln"
MsBuild "$srcDir\DocCode" "BreezeDocCode.sln"
MsBuild "$srcDir\Samples\Todo" "ToDo.sln"
MsBuild "$srcDir\Samples\BreezyDevices" "BreezyDevices.sln"

