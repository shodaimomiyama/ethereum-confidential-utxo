import concurrent.futures

from kontrol.__main__ import main


OriginalThreadPoolExecutor = concurrent.futures.ThreadPoolExecutor


class SequentialCompilerExecutor(OriginalThreadPoolExecutor):
    def __init__(self, max_workers=None, *arguments, **keywords):
        # Parallel JVMs exceeded this experiment's existing Docker VM memory.
        # Serializing compilation preserves the source and compiler arguments.
        super().__init__(1, *arguments, **keywords)


if __name__ == "__main__":
    concurrent.futures.ThreadPoolExecutor = SequentialCompilerExecutor
    main()
